const issuesByAppliance = {
  Refrigerator: [
    "Not cooling",
    "Leaking water",
    "Ice maker not working",
    "Making noise",
    "Not powering on",
    "Other issue"
  ],
  Washer: [
    "Not draining",
    "Leaking",
    "Not spinning",
    "Touch screen not working",
    "Mold odor / gasket issue",
    "Other issue"
  ],
  Dryer: [
    "Not heating",
    "Taking too long to dry",
    "Making noise",
    "Not turning on",
    "Burning smell",
    "Other issue"
  ],
  Cooktop: [
    "Burner not heating",
    "Cracked glass",
    "Touch controls not working",
    "Gas ignition issue",
    "Not powering on",
    "Other issue"
  ],
  Oven: [
    "No power",
    "No heating",
    "Temperature is off",
    "Door issue",
    "Display not working",
    "Other issue"
  ],
  Dishwasher: [
    "Not draining",
    "Not cleaning dishes",
    "Leaking",
    "Not drying",
    "Not turning on",
    "Other issue"
  ]
};

const brandsByAppliance = {
  Refrigerator: [
    "Samsung",
    "LG",
    "Whirlpool",
    "KitchenAid",
    "Thermador",
    "Sub-Zero",
    "Viking",
    "Miele",
    "Electrolux",
    "Frigidaire",
    "GE",
    "Bosch",
    "Maytag",
    "Other"
  ],
  Washer: [
    "Samsung",
    "LG",
    "Whirlpool",
    "Miele",
    "Electrolux",
    "Frigidaire",
    "GE",
    "Bosch",
    "Maytag",
    "Speed Queen",
    "Other"
  ],
  Dryer: [
    "Samsung",
    "LG",
    "Whirlpool",
    "Miele",
    "Electrolux",
    "Frigidaire",
    "GE",
    "Bosch",
    "Maytag",
    "Speed Queen",
    "Other"
  ],
  Cooktop: [
    "Samsung",
    "LG",
    "Whirlpool",
    "KitchenAid",
    "Thermador",
    "Viking",
    "Wolf",
    "Miele",
    "Electrolux",
    "Frigidaire",
    "GE",
    "Bosch",
    "Other"
  ],
  Oven: [
    "Samsung",
    "LG",
    "Whirlpool",
    "KitchenAid",
    "Thermador",
    "Viking",
    "Wolf",
    "Miele",
    "Electrolux",
    "Frigidaire",
    "GE",
    "Bosch",
    "Other"
  ],
  Dishwasher: [
    "Samsung",
    "LG",
    "Whirlpool",
    "KitchenAid",
    "Thermador",
    "Viking",
    "Miele",
    "Electrolux",
    "Frigidaire",
    "GE",
    "Bosch",
    "Cove",
    "Maytag",
    "Other"
  ]
};

const businessTimeSlots = [
  "9:00 AM - 11:00 AM",
  "11:00 AM - 1:00 PM",
  "1:00 PM - 3:00 PM",
  "3:00 PM - 5:00 PM",
  "5:00 PM - 7:00 PM"
];
const bookedSlotsStorageKey = "flex-repairs-booked-slots";
const confirmationStorageKey = "flex-repairs-confirmation";
const serviceCallPrice = 89;
const isLocalPreview = window.location.protocol === "file:";
let remoteBookedSlotsByDate = {};

const state = {
  step: 1,
  appliance: "",
  issue: "",
  brand: "",
  preferredDate: "",
  preferredDateKey: "",
  preferredTime: ""
};

const totalSteps = 7;
const steps = [...document.querySelectorAll(".flow-step")];
const stepLabel = document.getElementById("step-label");
const progressFill = document.getElementById("progress-fill");
const nextButton = document.getElementById("next-button");
const backButton = document.getElementById("back-button");
const issueList = document.getElementById("issue-list");
const brandGrid = document.getElementById("brand-grid");
const dateGrid = document.getElementById("date-grid");
const timeGrid = document.getElementById("time-grid");
const summaryCard = document.getElementById("summary-card");
const form = document.getElementById("booking-form");
const jumpButtons = [...document.querySelectorAll("[data-jump-to]")];
const formMessage = document.getElementById("form-message");
const applianceButtons = [...document.querySelectorAll('[data-field="appliance"]')];
const callButtons = [...document.querySelectorAll("[data-call-trigger]")];
const submitButton = form.querySelector('button[type="submit"]');

function getField(name) {
  return form.elements.namedItem(name);
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function focusField(name) {
  const field = getField(name);
  if (!field || typeof field.focus !== "function") return;

  field.focus();
  field.scrollIntoView({ behavior: "smooth", block: "center" });
}

function focusTarget(target) {
  if (!target || typeof target.focus !== "function") return;

  target.focus();
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setFormMessage(message = "", type = "error") {
  if (!message) {
    formMessage.hidden = true;
    formMessage.textContent = "";
    formMessage.dataset.type = "";
    return;
  }

  formMessage.hidden = false;
  formMessage.dataset.type = type;
  formMessage.textContent = message;
}

function syncApplianceSelection() {
  applianceButtons.forEach((button) => {
    const isSelected = button.dataset.value === state.appliance;
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });
}

function getDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateOptions() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  });

  const options = [];
  let offset = 0;

  while (options.length < 6) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const currentOffset = offset;
    offset += 1;

    options.push({
      key: getDateKey(date),
      label: formatter.format(date),
      offset: currentOffset
    });
  }

  return options;
}

function loadBookedSlots() {
  try {
    const raw = window.localStorage.getItem(bookedSlotsStorageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveBookedSlots(bookedSlots) {
  try {
    window.localStorage.setItem(bookedSlotsStorageKey, JSON.stringify(bookedSlots));
  } catch {
    // Ignore storage limits and continue without local slot memory.
  }
}

async function refreshAvailability() {
  if (isLocalPreview) return;

  const dateKeys = getDateOptions()
    .map((option) => option.key)
    .join(",");

  try {
    const response = await fetch(`/api/availability?dateKeys=${encodeURIComponent(dateKeys)}`, {
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error(data.message || "Unable to load live availability.");
    }

    remoteBookedSlotsByDate = data.slotsByDate || {};

    if (state.step === 6) {
      renderDates();
      renderTimes();
    }
  } catch (error) {
    setFormMessage(error.message || "Unable to load live availability right now.");
  }
}

function getUnavailableSlots(dateKey) {
  const storedSlots = isLocalPreview
    ? loadBookedSlots()[dateKey] || []
    : remoteBookedSlotsByDate[dateKey] || [];
  return [...new Set(storedSlots)];
}

function renderIssues() {
  const issues = issuesByAppliance[state.appliance] || [];
  issueList.innerHTML = issues
    .map(
      (issue) => `
        <button
          class="choice-card ${state.issue === issue ? "selected" : ""}"
          type="button"
          data-field="issue"
          data-value="${issue}"
        >
          <strong>${issue}</strong>
        </button>
      `
    )
    .join("");
}

function renderBrands() {
  const brands = brandsByAppliance[state.appliance] || [];

  if (state.brand && !brands.includes(state.brand)) {
    state.brand = "";
  }

  brandGrid.innerHTML = brands
    .map(
      (brand) => `
        <button
          class="brand-card ${state.brand === brand ? "selected" : ""}"
          type="button"
          data-field="brand"
          data-value="${brand}"
        >
          <strong>${brand}</strong>
        </button>
      `
    )
    .join("");
}

function renderDates() {
  const dates = getDateOptions();

  if (
    state.preferredDateKey &&
    !dates.some((date) => date.key === state.preferredDateKey)
  ) {
    state.preferredDateKey = "";
    state.preferredDate = "";
    state.preferredTime = "";
  }

  if (
    state.preferredDateKey &&
    getUnavailableSlots(state.preferredDateKey).length >= businessTimeSlots.length
  ) {
    state.preferredDateKey = "";
    state.preferredDate = "";
    state.preferredTime = "";
  }

  dateGrid.innerHTML = dates
    .map(
      (date) => {
        const unavailableCount = getUnavailableSlots(date.key).length;
        const availableCount = Math.max(0, businessTimeSlots.length - unavailableCount);
        const isBookedOut = availableCount === 0;

        return `
        <button
          class="date-card ${state.preferredDateKey === date.key ? "selected" : ""} ${isBookedOut ? "unavailable" : ""}"
          type="button"
          data-field="preferredDate"
          data-value="${date.key}"
          data-label="${date.label}"
          ${isBookedOut ? "disabled" : ""}
        >
          <strong>${date.label}</strong>
          <span>${isBookedOut ? "Fully booked" : `${availableCount} windows left`}</span>
        </button>
      `
      }
    )
    .join("");
}

function renderTimes() {
  if (!timeGrid) {
    return;
  }

  if (!state.preferredDateKey) {
    timeGrid.innerHTML = `
      <div class="time-placeholder">
        Select a date first and the open time windows will appear here.
      </div>
    `;
    return;
  }

  const unavailableSlots = new Set(getUnavailableSlots(state.preferredDateKey));

  if (state.preferredTime && unavailableSlots.has(state.preferredTime)) {
    state.preferredTime = "";
  }

  timeGrid.innerHTML = businessTimeSlots
    .map((slot) => {
      const isUnavailable = unavailableSlots.has(slot);
      return `
        <button
          class="time-card ${state.preferredTime === slot ? "selected" : ""} ${isUnavailable ? "unavailable" : ""}"
          type="button"
          data-field="preferredTime"
          data-value="${slot}"
          ${isUnavailable ? "disabled" : ""}
        >
          <strong>${slot}</strong>
          <span>${isUnavailable ? "Booked" : "Available"}</span>
        </button>
      `;
    })
    .join("");
}

function updateStepView() {
  steps.forEach((step) => {
    step.classList.toggle("active", Number(step.dataset.step) === state.step);
  });

  syncApplianceSelection();
  setFormMessage();
  stepLabel.textContent = `Step ${state.step} of ${totalSteps}`;
  progressFill.style.width = `${(state.step / totalSteps) * 100}%`;
  backButton.disabled = state.step === 1;
  nextButton.style.display = state.step === totalSteps ? "none" : "inline-flex";

  if (state.step === 2) {
    renderIssues();
  }

  if (state.step === 3) {
    renderBrands();
  }

  if (state.step === 6) {
    renderDates();
    renderTimes();
    refreshAvailability();
  }

  if (state.step === 7) {
    renderSummary();
  }
}

function renderSummary() {
  const data = new FormData(form);
  const email = normalizeEmail(data.get("email"));
  const lines = [
    ["Appliance", state.appliance || "Not selected"],
    ["Issue", state.issue || "Not selected"],
    ["Brand", state.brand || "Not selected"],
    ["ZIP code", data.get("zipCode") || "Not provided"],
    ["City", data.get("city") || "Not provided"],
    ["Address", data.get("address") || "Not provided"],
    [
      "Customer",
      `${data.get("firstName") || ""} ${data.get("lastName") || ""}`.trim() || "Not provided"
    ],
    ["Phone", data.get("phone") || "Not provided"],
    ["Email", email || "Not provided"],
    ["Preferred date", state.preferredDate || "To be confirmed"],
    ["Preferred time", state.preferredTime || "To be confirmed"],
    ["Notes", data.get("notes") || "None"]
  ];

  summaryCard.replaceChildren();

  lines.forEach(([label, value]) => {
    const line = document.createElement("div");
    const labelNode = document.createElement("small");
    const valueNode = document.createElement("strong");

    line.className = "summary-line";
    labelNode.textContent = label;
    valueNode.textContent = String(value);

    line.append(labelNode, valueNode);
    summaryCard.append(line);
  });
}

function buildSubmissionPayload() {
  const data = new FormData(form);

  return {
    appliance: state.appliance,
    issue: state.issue,
    brand: state.brand,
    zipCode: String(data.get("zipCode") || "").trim(),
    city: String(data.get("city") || "").trim(),
    address: String(data.get("address") || "").trim(),
    firstName: String(data.get("firstName") || "").trim(),
    lastName: String(data.get("lastName") || "").trim(),
    phone: String(data.get("phone") || "").trim(),
    email: normalizeEmail(data.get("email")),
    preferredDate: state.preferredDate,
    preferredDateKey: state.preferredDateKey,
    preferredTime: state.preferredTime,
    notes: String(data.get("notes") || "").trim()
  };
}

function formatConfirmationAddress(payload) {
  return [payload.address, payload.city, payload.zipCode]
    .filter((part) => part && part !== "Not provided")
    .join(", ");
}

function persistConfirmation(payload) {
  const confirmation = {
    firstName: payload.firstName || "",
    email: payload.email || "",
    appliance: payload.appliance || "Appliance repair",
    preferredDate: payload.preferredDate || "To be confirmed",
    preferredTime: payload.preferredTime || "To be confirmed",
    address: formatConfirmationAddress(payload) || "Address to be confirmed",
    serviceCallPrice,
    totalEstimatedPrice: serviceCallPrice,
    createdAt: Date.now()
  };

  try {
    window.sessionStorage.setItem(confirmationStorageKey, JSON.stringify(confirmation));
  } catch {
    // Ignore storage failures and continue to the thank-you page.
  }
}

function getStepError(step) {
  const data = new FormData(form);

  if (step === 1 && !state.appliance) {
    return { message: "Choose an appliance before continuing." };
  }

  if (step === 2 && !state.issue) {
    return { message: "Select the main issue so we know what to expect." };
  }

  if (step === 3 && !state.brand) {
    return { message: "Select the appliance brand before moving on." };
  }

  if (step === 4) {
    const zipCode = String(data.get("zipCode") || "").trim();
    const address = String(data.get("address") || "").trim();

    if (!/^\d{5}(?:-\d{4})?$/.test(zipCode)) {
      return { message: "Enter a valid ZIP code in 5-digit format.", field: "zipCode" };
    }

    if (!address) {
      return { message: "Add the street address before continuing.", field: "address" };
    }
  }

  if (step === 5) {
    const firstName = String(data.get("firstName") || "").trim();
    const phone = String(data.get("phone") || "").trim();

    if (!firstName) {
      return { message: "Enter the customer's first name.", field: "firstName" };
    }

    if (phone.replace(/\D/g, "").length < 10) {
      return { message: "Enter a valid phone number with at least 10 digits.", field: "phone" };
    }
  }

  if (step === 6) {
    if (!state.preferredDateKey) {
      return { message: "Choose a date before continuing.", target: dateGrid };
    }

    if (!state.preferredTime) {
      return { message: "Choose an available time window before continuing.", target: timeGrid };
    }
  }

  return null;
}

function validateStep(step = state.step) {
  const error = getStepError(step);
  if (!error) return true;

  setFormMessage(error.message);
  if (error.field) {
    focusField(error.field);
  }
  if (error.target) {
    focusTarget(error.target);
  }

  return false;
}

function validateAllSteps() {
  for (let step = 1; step < totalSteps; step += 1) {
    const error = getStepError(step);
    if (!error) continue;

    goToStep(step);
    setFormMessage(error.message);

    if (error.field) {
      focusField(error.field);
    }
    if (error.target) {
      focusTarget(error.target);
    }

    return false;
  }

  return true;
}

function goToStep(step) {
  state.step = Math.max(1, Math.min(totalSteps, step));
  updateStepView();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-field]");
  if (!target) return;

  const field = target.dataset.field;
  const value = target.dataset.value;

  if (field === "preferredDate") {
    state.preferredDateKey = value;
    state.preferredDate = target.dataset.label || value;
    state.preferredTime = "";
    updateStepView();
    focusTarget(timeGrid);
    return;
  }

  state[field] = value;

  if (field === "appliance") {
    state.issue = "";
  }

  updateStepView();

  if (field === "appliance") {
    setTimeout(() => {
      nextButton.focus();
    }, 0);
  }
});

nextButton.addEventListener("click", () => {
  if (!validateStep()) return;
  goToStep(state.step + 1);
});

backButton.addEventListener("click", () => {
  goToStep(state.step - 1);
});

jumpButtons.forEach((button) => {
  button.addEventListener("click", () => {
    goToStep(Number(button.dataset.jumpTo) || 1);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

callButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const chipId = button.getAttribute("aria-controls");
    const chip = chipId ? document.getElementById(chipId) : null;
    if (!chip) return;

    chip.hidden = false;
    button.setAttribute("aria-expanded", "true");
  });
});

const emailField = getField("email");
if (emailField) {
  emailField.addEventListener("blur", () => {
    emailField.value = normalizeEmail(emailField.value);
  });
}

form.addEventListener("input", () => {
  if (!formMessage.hidden) {
    setFormMessage();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validateAllSteps()) return;

  const existing = form.querySelector(".submit-note");
  if (existing) existing.remove();

  const payload = buildSubmissionPayload();

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Sending...";
  }

  if (isLocalPreview) {
    const bookedSlots = loadBookedSlots();
    const selectedSlots = new Set(bookedSlots[state.preferredDateKey] || []);

    if (selectedSlots.has(state.preferredTime)) {
      setFormMessage("That time window is already booked in local preview. Please choose another one.");

      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Request service";
      }

      return;
    }

    selectedSlots.add(state.preferredTime);
    bookedSlots[state.preferredDateKey] = [...selectedSlots];
    saveBookedSlots(bookedSlots);
    renderSummary();

    persistConfirmation(payload);
    setFormMessage("Local preview saved successfully.", "success");

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Request service";
    }

    const thankYouUrl = "thank-you.html";
    window.setTimeout(() => {
      window.location.assign(thankYouUrl);
    }, 300);
    return;
  }

  fetch("/api/jobber-request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Unable to send the request right now.");
      }

      renderSummary();

      if (isLocalPreview) {
        const bookedSlots = loadBookedSlots();
        const selectedSlots = new Set(bookedSlots[state.preferredDateKey] || []);

        if (state.preferredTime) {
          selectedSlots.add(state.preferredTime);
          bookedSlots[state.preferredDateKey] = [...selectedSlots];
          saveBookedSlots(bookedSlots);
        }
      } else if (state.preferredDateKey && state.preferredTime) {
        const selectedSlots = new Set(remoteBookedSlotsByDate[state.preferredDateKey] || []);
        selectedSlots.add(state.preferredTime);
        remoteBookedSlotsByDate[state.preferredDateKey] = [...selectedSlots];
      }

      persistConfirmation(payload);
      setFormMessage(data.message || "Everything looks good. Your request was received.", "success");

      const thankYouUrl = isLocalPreview ? "thank-you.html" : "/thank-you.html";
      window.setTimeout(() => {
        window.location.assign(thankYouUrl);
      }, 300);
    })
    .catch((error) => {
      setFormMessage(error.message || "Unable to send the request right now.");
      if (!isLocalPreview) {
        refreshAvailability();
      }
    })
    .finally(() => {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Request service";
      }
    });
});

updateStepView();
