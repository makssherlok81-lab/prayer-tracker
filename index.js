const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// ── PRAYER TIME CALCULATION (same as in the app) ──
function julianDate(date) {
  let Y = date.getFullYear(), M = date.getMonth() + 1, D = date.getDate();
  if (M <= 2) { Y--; M += 12; }
  return Math.floor(365.25 * (Y + 4716)) + Math.floor(30.6001 * (M + 1)) + D - 1524.5;
}

function calcDhuhrMinutes(lat, lng, date) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const jd = julianDate(date);
  const D = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * D) % 360;
  const q = (280.459 + 0.98564736 * D) % 360;
  const L = (q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;
  const e = 23.439 - 0.00000036 * D;
  const RA = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad)) * deg / 15;
  const EqT = q / 15 - RA;
  const noon = 12 - EqT - lng / 15;
  return Math.round(noon * 60); // minutes since midnight (local solar time offset)
}

// ── HIJRI CALENDAR (same as in the app) ──
function gregorianToJD(date) {
  return julianDate(date);
}

function jdToHijri(jd) {
  const z = Math.floor(jd + 0.5);
  const a = Math.floor((z - 1867216.25) / 36524.25);
  const b = z + 1 + a - Math.floor(a / 4) + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  // Convert Gregorian to Hijri approximation
  const jdEpoch = 1948438.5;
  const hijriDays = z - jdEpoch;
  const hijriYear = Math.floor((30 * hijriDays + 10646) / 10631);
  const hijriYearStart = Math.floor((11 * hijriYear + 3) / 30) + 354 * hijriYear + jdEpoch;
  const hijriMonth = Math.min(12, Math.ceil((z - hijriYearStart) / 29.5) + 1);
  const monthStart = Math.floor((11 * hijriYear + 3) / 30) + 354 * hijriYear + Math.ceil(29.5 * (hijriMonth - 1)) + jdEpoch;
  const hijriDay = z - monthStart + 1;
  return { year: hijriYear, month: hijriMonth, day: hijriDay };
}

function getHijri(date) {
  return jdToHijri(gregorianToJD(date));
}

// ── ISLAMIC OCCASIONS (same as in the app) ──
const OCCASIONS = [
  { name: "Dhul Hijjah — Sacred Days", hijriMonth: 12, hijriDayStart: 1,  hijriDayEnd: 9,  desc: "Fast the first 9 days of Dhul Hijjah" },
  { name: "Day of Arafah",             hijriMonth: 12, hijriDayStart: 9,  hijriDayEnd: 9,  desc: "The best day of the year — fast and make du'a" },
  { name: "Eid al-Adha",               hijriMonth: 12, hijriDayStart: 10, hijriDayEnd: 13, desc: "Eid Mubarak! Fasting is forbidden these days" },
  { name: "Ashura Fast",               hijriMonth: 1,  hijriDayStart: 9,  hijriDayEnd: 10, desc: "Fast on the 9th and 10th of Muharram" },
  { name: "White Days",                hijriMonth: 0,  hijriDayStart: 13, hijriDayEnd: 15, desc: "Fast the 13th, 14th and 15th of each Hijri month" },
];

function getOccasionNotificationsForDate(checkDate) {
  // Returns occasions that START in exactly 3 days or 1 day from checkDate
  const notifications = [];
  const today = new Date(checkDate);

  for (const occ of OCCASIONS) {
    for (let i = 0; i <= 180; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const h = getHijri(d);
      const matchMonth = occ.hijriMonth === 0 || occ.hijriMonth === h.month;
      const matchDay = h.day >= occ.hijriDayStart && h.day <= occ.hijriDayEnd;
      if (matchMonth && matchDay) {
        // Walk back to find actual start
        const startDay = new Date(d);
        while (true) {
          const prev = new Date(startDay);
          prev.setDate(prev.getDate() - 1);
          const ph = getHijri(prev);
          const pMatch = (occ.hijriMonth === 0 || occ.hijriMonth === ph.month) &&
            ph.day >= occ.hijriDayStart && ph.day <= occ.hijriDayEnd;
          const notPast = prev >= today;
          if (pMatch && notPast) startDay.setDate(startDay.getDate() - 1);
          else break;
        }
        const daysUntil = Math.round((startDay - today) / 86400000);
        if (daysUntil === 3 || daysUntil === 1) {
          notifications.push({
            name: occ.name,
            desc: occ.desc,
            daysUntil
          });
        }
        break;
      }
    }
  }
  return notifications;
}

// ── CITY NAME FROM COORDINATES (reverse geocoding) ──
async function getCityName(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
    const res = await fetch(url, { headers: { "User-Agent": "PrayerTrackerApp/1.0" } });
    const data = await res.json();
    return data.address?.city || data.address?.town || data.address?.village || null;
  } catch (e) {
    return null;
  }
}

// ── SEND NOTIFICATION ──
async function sendNotification(token, title, body) {
  try {
    await getMessaging().send({
      token,
      notification: { title, body },
      webpush: {
        notification: {
          title,
          body,
          icon: "https://makssherlok81-lab.github.io/prayer-tracker/icon-192.png",
          badge: "https://makssherlok81-lab.github.io/prayer-tracker/icon-192.png",
        },
        fcmOptions: {
          link: "https://makssherlok81-lab.github.io/prayer-tracker/prayer-tracker.html"
        }
      }
    });
    return true;
  } catch (e) {
    console.error("Failed to send to token:", e.message);
    return false;
  }
}

// ── MAIN SCHEDULED FUNCTION — runs every day at midnight UTC ──
exports.sendDailyReminders = onSchedule("0 0 * * *", async (event) => {
  const now = new Date();
  const snapshot = await db.collection("fcmTokens").get();

  for (const docSnap of snapshot.docs) {
    const { token, lat, lng, tz } = docSnap.data();
    if (!token) continue;

    try {
      // Get local date for this user based on their timezone
      const localDateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz || "UTC",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(now);
      const localDate = new Date(localDateStr);

      // ── 1. DHUHR REMINDER ──
      // Only send if current UTC time is after their Dhuhr time
      if (lat && lng) {
        const dhuhrMinutes = calcDhuhrMinutes(lat, lng, localDate);
        // Get current local time in minutes
        const localTimeStr = new Intl.DateTimeFormat("en-GB", {
          timeZone: tz || "UTC",
          hour: "2-digit", minute: "2-digit", hour12: false
        }).format(now);
        const [hh, mm] = localTimeStr.split(":").map(Number);
        const currentMinutes = hh * 60 + mm;
        const reminderMinutes = dhuhrMinutes + 30; // 30 min after Dhuhr

        // We run at midnight UTC — so we schedule via a window check
        // Send if it's between 30min and 90min after Dhuhr in local time
        if (currentMinutes >= reminderMinutes && currentMinutes <= reminderMinutes + 60) {
          const city = docSnap.data().city || await getCityName(lat, lng);
          const locationStr = city ? ` (${city})` : "";
          await sendNotification(
            token,
            "🕌 Did you pray Dhuhr?",
            `Dhuhr time has passed${locationStr} — don't forget to log your prayers.`
          );
        }
      }

      // ── 2. OCCASION REMINDERS ──
      const occasionNotifs = getOccasionNotificationsForDate(localDate);
      for (const occ of occasionNotifs) {
        const when = occ.daysUntil === 1 ? "tomorrow" : "in 3 days";
        await sendNotification(
          token,
          `🌙 ${occ.name} — ${when}`,
          occ.desc
        );
      }

    } catch (e) {
      console.error(`Error processing user ${docSnap.id}:`, e.message);
    }
  }

  console.log(`Processed ${snapshot.docs.length} users`);
});

// ── DHUHR-TIMED FUNCTION — runs every hour to catch Dhuhr windows ──
exports.sendDhuhrReminder = onSchedule("0 * * * *", async (event) => {
  const now = new Date();
  const snapshot = await db.collection("fcmTokens").get();

  for (const docSnap of snapshot.docs) {
    const { token, lat, lng, tz, lastDhuhrNotif } = docSnap.data();
    if (!token || !lat || !lng) continue;

    try {
      const localDateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz || "UTC",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(now);
      const localDate = new Date(localDateStr);
      const todayKey = localDateStr;

      // Don't send twice on the same day
      if (lastDhuhrNotif === todayKey) continue;

      const dhuhrMinutes = calcDhuhrMinutes(lat, lng, localDate);
      const localTimeStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz || "UTC",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).format(now);
      const [hh, mm] = localTimeStr.split(":").map(Number);
      const currentMinutes = hh * 60 + mm;
      const reminderMinutes = dhuhrMinutes + 30;

      // Send if we're within the hour window after Dhuhr + 30min
      if (currentMinutes >= reminderMinutes && currentMinutes < reminderMinutes + 60) {
        const city = await getCityName(lat, lng);
        const locationStr = city ? ` (${city})` : "";
        const city2 = docSnap.data().city || await getCityName(lat, lng);
        const locationStr2 = city2 ? ` (${city2})` : "";
        const sent = await sendNotification(
          token,
          "🕌 Did you pray Dhuhr?",
          `Dhuhr time has passed${locationStr2} — don't forget to log your prayers.`
        );
        if (sent) {
          // Mark as sent for today so we don't send again
          await db.collection("fcmTokens").doc(docSnap.id).update({ lastDhuhrNotif: todayKey });
        }
      }
    } catch (e) {
      console.error(`Dhuhr error for ${docSnap.id}:`, e.message);
    }
  }
});
