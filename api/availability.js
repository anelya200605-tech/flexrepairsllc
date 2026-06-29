"use strict";

const {
  getEnv,
  jobberGraphQL,
  refreshAccessToken,
  sendJson
} = require("./_lib/jobber");
const { getSlotsKey, runRedisPipeline } = require("./_lib/upstash");

const BUSINESS_TIME_SLOTS = [
  { label: "9:00 AM - 11:00 AM", startHour: 9, endHour: 11 },
  { label: "11:00 AM - 1:00 PM", startHour: 11, endHour: 13 },
  { label: "1:00 PM - 3:00 PM", startHour: 13, endHour: 15 },
  { label: "3:00 PM - 5:00 PM", startHour: 15, endHour: 17 },
  { label: "5:00 PM - 7:00 PM", startHour: 17, endHour: 19 }
];

const JOBBER_TIMEZONE = "America/Chicago";

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey)
    .split("-")
    .map((part) => Number.parseInt(part, 10));

  return { year, month, day };
}

function addDays(dateKey, days) {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return Math.round((asUtc - date.getTime()) / 60000);
}

function zonedDateTimeToUtc(dateKey, hour, minute = 0, timeZone = JOBBER_TIMEZONE) {
  const { year, month, day } = parseDateKey(dateKey);
  const guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, guessUtc);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMinutes * 60000);
}

function getTimeRangeForDateKeys(dateKeys) {
  const sorted = [...dateKeys].sort();
  const firstDateKey = sorted[0];
  const lastDateKey = sorted[sorted.length - 1];
  const nextAfterLast = addDays(lastDateKey, 1);

  return {
    startIso: zonedDateTimeToUtc(firstDateKey, 0, 0).toISOString(),
    endIso: zonedDateTimeToUtc(nextAfterLast, 0, 0).toISOString()
  };
}

function getDateKeyInTimeZone(date, timeZone = JOBBER_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(date);
}

function overlaps(rangeAStart, rangeAEnd, rangeBStart, rangeBEnd) {
  return rangeAStart < rangeBEnd && rangeBStart < rangeAEnd;
}

async function tryScheduledItemsQuery(accessToken, startIso, endIso) {
  const candidates = [
    { occursWithin: { startAt: startIso, endAt: endIso } },
    { occursWithin: { startsAt: startIso, endsAt: endIso } },
    { occursWithin: { from: startIso, to: endIso } },
    { occursWithin: { atOrAfter: startIso, atOrBefore: endIso } }
  ];

  const query = `
    query FlexRepairsScheduledItems($filter: ScheduledItemsFilterAttributes!, $after: String) {
      scheduledItems(filter: $filter, first: 100, after: $after) {
        nodes {
          __typename
          ... on Visit {
            id
            startAt
            endAt
            allDay
            title
          }
          ... on Assessment {
            id
            startAt
            endAt
            allDay
            title
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const errors = [];

  for (const filter of candidates) {
    try {
      const items = [];
      let after = null;

      while (true) {
        const data = await jobberGraphQL(accessToken, query, { filter, after });
        const connection = data && data.data ? data.data.scheduledItems : null;
        const nodes = connection && Array.isArray(connection.nodes) ? connection.nodes : [];
        items.push(...nodes);

        const pageInfo = connection && connection.pageInfo ? connection.pageInfo : null;
        if (!pageInfo || !pageInfo.hasNextPage || !pageInfo.endCursor) {
          break;
        }

        after = pageInfo.endCursor;
      }

      return { items, strategy: "scheduledItems" };
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(errors[errors.length - 1] || "Unable to query Jobber scheduled items.");
}

async function tryVisitsQuery(accessToken, startIso, endIso) {
  const candidates = [
    { startAt: { atOrAfter: startIso, atOrBefore: endIso } },
    { startAt: { startAt: startIso, endAt: endIso } },
    { startAt: { from: startIso, to: endIso } }
  ];

  const query = `
    query FlexRepairsVisits($filter: VisitFilterAttributes, $after: String) {
      visits(filter: $filter, first: 100, after: $after) {
        nodes {
          __typename
          id
          startAt
          endAt
          allDay
          title
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const errors = [];

  for (const filter of candidates) {
    try {
      const items = [];
      let after = null;

      while (true) {
        const data = await jobberGraphQL(accessToken, query, { filter, after });
        const connection = data && data.data ? data.data.visits : null;
        const nodes = connection && Array.isArray(connection.nodes) ? connection.nodes : [];
        items.push(...nodes);

        const pageInfo = connection && connection.pageInfo ? connection.pageInfo : null;
        if (!pageInfo || !pageInfo.hasNextPage || !pageInfo.endCursor) {
          break;
        }

        after = pageInfo.endCursor;
      }

      return { items, strategy: "visits" };
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(errors[errors.length - 1] || "Unable to query Jobber visits.");
}

async function loadJobberScheduledItems(dateKeys) {
  const refreshToken = getEnv("JOBBER_REFRESH_TOKEN");
  const tokenData = await refreshAccessToken(refreshToken);
  const accessToken = String(tokenData.access_token || "").trim();

  if (!accessToken) {
    throw new Error("Jobber access token is missing after refresh.");
  }

  const { startIso, endIso } = getTimeRangeForDateKeys(dateKeys);

  try {
    return await tryScheduledItemsQuery(accessToken, startIso, endIso);
  } catch (scheduledItemsError) {
    const fallback = await tryVisitsQuery(accessToken, startIso, endIso).catch((visitsError) => {
      throw new Error(
        [
          scheduledItemsError.message || String(scheduledItemsError),
          visitsError.message || String(visitsError)
        ].join(" | ")
      );
    });

    return fallback;
  }
}

function getBookedSlotsFromJobber(dateKeys, items) {
  const slotsByDate = Object.fromEntries(dateKeys.map((dateKey) => [dateKey, new Set()]));

  for (const item of items) {
    if (!item || !item.startAt) continue;

    const itemStart = new Date(item.startAt);
    const itemEnd = item.endAt ? new Date(item.endAt) : new Date(item.startAt);

    for (const dateKey of dateKeys) {
      if (!slotsByDate[dateKey]) continue;

      if (item.allDay) {
        const itemDateKey = getDateKeyInTimeZone(itemStart);
        if (itemDateKey === dateKey) {
          BUSINESS_TIME_SLOTS.forEach((slot) => slotsByDate[dateKey].add(slot.label));
        }
        continue;
      }

      for (const slot of BUSINESS_TIME_SLOTS) {
        const slotStart = zonedDateTimeToUtc(dateKey, slot.startHour, 0);
        const slotEnd = zonedDateTimeToUtc(dateKey, slot.endHour, 0);

        if (overlaps(itemStart, itemEnd, slotStart, slotEnd)) {
          slotsByDate[dateKey].add(slot.label);
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(slotsByDate).map(([dateKey, set]) => [dateKey, [...set]])
  );
}

function mergeSlots(dateKeys, redisSlotsByDate, jobberSlotsByDate) {
  const merged = {};

  for (const dateKey of dateKeys) {
    merged[dateKey] = [
      ...new Set([...(redisSlotsByDate[dateKey] || []), ...(jobberSlotsByDate[dateKey] || [])])
    ];
  }

  return merged;
}

async function loadRedisSlots(dateKeys) {
  try {
    const redisResults = await runRedisPipeline(
      dateKeys.map((dateKey) => ["HKEYS", getSlotsKey(dateKey)])
    );

    return {
      slotsByDate: Object.fromEntries(
        dateKeys.map((dateKey, index) => {
          const item = redisResults[index];
          return [dateKey, item && Array.isArray(item.result) ? item.result : []];
        })
      ),
      warning: ""
    };
  } catch (error) {
    return {
      slotsByDate: Object.fromEntries(dateKeys.map((dateKey) => [dateKey, []])),
      warning: error && error.message ? error.message : "Unable to read temporary website reservations."
    };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { ok: false, message: "Method not allowed." });
  }

  try {
    res.setHeader("Cache-Control", "no-store");

    const rawDateKeys = String(req.query.dateKeys || "").trim();
    const dateKeys = rawDateKeys
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 12);

    if (!dateKeys.length) {
      return sendJson(res, 400, { ok: false, message: "Missing dateKeys." });
    }

    const redisResult = await loadRedisSlots(dateKeys);
    const redisSlotsByDate = redisResult.slotsByDate;

    let jobberSlotsByDate = Object.fromEntries(dateKeys.map((dateKey) => [dateKey, []]));
    let jobberStrategy = "unavailable";
    let jobberWarning = "";

    try {
      const jobberResult = await loadJobberScheduledItems(dateKeys);
      jobberStrategy = jobberResult.strategy;
      jobberSlotsByDate = getBookedSlotsFromJobber(dateKeys, jobberResult.items || []);
    } catch (error) {
      jobberWarning = error.message || "Unable to read live Jobber schedule.";
    }

    const slotsByDate = mergeSlots(dateKeys, redisSlotsByDate, jobberSlotsByDate);

    return sendJson(res, 200, {
      ok: true,
      slotsByDate,
      meta: {
        jobberStrategy,
        jobberWarning,
        redisWarning: redisResult.warning
      }
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      message: error.message || "Unable to load availability."
    });
  }
};
