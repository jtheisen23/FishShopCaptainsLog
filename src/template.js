/**
 * The shift cards, in code form.
 *
 * Two logs run the day and dovetail at the handover: the OPENING log ends with
 * Deck Walk 4 handing over to the incoming manager, and the CLOSING log starts
 * with Deck Walk 1 receiving from the outgoing one.
 *
 * Item `key`s are stable identifiers that completed checks are stored against,
 * so DO NOT rename a key once a shift has been logged with it — change the
 * `label` freely, but treat keys as permanent. Adding, removing or re-keying
 * items means bumping TEMPLATE_VERSION; each shift records the version and the
 * template it ran under.
 *
 * `deckWalk: n` marks the four walks. They're ordinary checkable items — a deck
 * walk is something you do and tick — just drawn with more weight.
 */

export const TEMPLATE_VERSION = 2;

const OPENING = {
  key: 'opening',
  name: 'Opening',
  blurb: 'Open the restaurant and hand over to the closing manager.',
  sections: [
    {
      key: 'daily-admin',
      title: 'Daily Admin',
      blurb: 'Office work, before you hit the floor.',
      items: [
        { key: 'admin-safe-count', label: "Count safe; verify last night's deposit" },
        { key: 'admin-bank-run', label: 'Bank run and change order' },
        { key: 'admin-timecards', label: "Approve yesterday's timecard edits" },
        { key: 'admin-labor-review', label: "Yesterday's labor vs. schedule; note overs" },
        { key: 'admin-schedule-holes', label: "Tomorrow's schedule: holes covered" },
        { key: 'admin-guest-feedback', label: 'Read guest feedback and reviews; respond' },
        { key: 'admin-maintenance-log', label: 'Log repair and maintenance issues' },
      ],
    },
    {
      key: 'before-open',
      title: 'Before Open',
      items: [
        { key: 'open-deck-walk-1', label: 'Deck Walk 1 — shift start', deckWalk: 1 },
        { key: 'open-forecast-tracker', label: 'ShiftEdge forecast into tracker' },
        { key: 'open-deployment-board', label: 'Positions and breaks on deployment board' },
        { key: 'open-line-check', label: 'Line check with kitchen lead: temps, dates' },
        { key: 'open-deliveries', label: 'Deliveries checked in; fish iced on arrival' },
        { key: 'open-market-case', label: 'Market case load, full, tagged and priced' },
        { key: 'open-assign-tills', label: 'Assign tills and bar drawer' },
        { key: 'open-detail-cleaning', label: 'Assign detail cleaning tasks by position' },
      ],
    },
    {
      key: 'open',
      title: 'Open',
      items: [
        { key: 'open-doors', label: 'Doors unlocked; signs, lights and music on' },
        { key: 'open-patio', label: 'Patio set: tables, umbrellas, dog bowls' },
        { key: 'open-online-ordering', label: 'Toast online ordering on; 86 list current' },
        { key: 'open-clock-schedule', label: 'On the clock matches the schedule' },
      ],
    },
    {
      key: 'pre-peak',
      title: 'Pre-Peak',
      items: [
        { key: 'open-deck-walk-2', label: 'Deck Walk 2 — before the push', deckWalk: 2 },
        { key: 'prepeak-huddle', label: 'Pre-shift huddle: forecast, positions, focus' },
        { key: 'prepeak-stations', label: 'Stations stocked, backups in place' },
        { key: 'prepeak-breaks', label: 'Meal breaks done or timed around the push' },
      ],
    },
    {
      key: 'peak',
      title: 'Peak',
      items: [
        { key: 'peak-run-floor', label: 'Run the shift from the floor, not the office' },
        { key: 'peak-staff-to-chart', label: 'Staff to the chart as the band climbs' },
        { key: 'peak-log-sales', label: 'Log sales and bodies every half hour' },
      ],
    },
    {
      key: 'post-peak',
      title: 'Post-Peak',
      items: [
        { key: 'open-deck-walk-3', label: 'Deck Walk 3 — after the push', deckWalk: 3 },
        { key: 'postpeak-phase-down', label: 'Phase down to the chart; cut in order' },
        { key: 'postpeak-breaks', label: 'Finish meal and rest breaks' },
        { key: 'postpeak-till-audit', label: 'Till audit' },
        { key: 'postpeak-restock', label: 'Restock, reset, check detail cleaning' },
        { key: 'postpeak-count-tills', label: 'Count tills with cashiers before they go' },
      ],
    },
    {
      key: 'transition',
      title: 'Transition',
      items: [
        { key: 'open-deck-walk-4', label: 'Deck Walk 4 — with incoming manager', deckWalk: 4 },
        { key: 'transition-huddle', label: 'Huddle: sales, labor, 86s, open issues' },
        { key: 'transition-safe-count', label: 'Count safe with incoming manager' },
        { key: 'transition-deposit-log', label: 'Cash and deposit log complete' },
        { key: 'transition-recap', label: 'Finish shift summary; send shift recap' },
      ],
    },
  ],
};

const CLOSING = {
  key: 'closing',
  name: 'Closing',
  blurb: 'Take the handover, run the night, close the building.',
  sections: [
    {
      key: 'shift-start',
      title: 'Shift Start',
      items: [
        { key: 'close-deck-walk-1', label: 'Deck Walk 1 — with outgoing manager', deckWalk: 1 },
        { key: 'close-huddle', label: 'Huddle: sales, labor, 86s, open issues' },
        { key: 'close-safe-count', label: 'Count safe with outgoing manager' },
        { key: 'close-forecast-tracker', label: 'ShiftEdge forecast into tracker' },
        { key: 'close-deployment-board', label: 'Positions and breaks on deployment board' },
        { key: 'close-clock-schedule', label: 'On the clock matches the schedule' },
        { key: 'close-assign-tasks', label: 'Assign closing and detail tasks by position' },
      ],
    },
    {
      key: 'pre-peak',
      title: 'Pre-Peak',
      items: [
        { key: 'close-deck-walk-2', label: 'Deck Walk 2 — before the push', deckWalk: 2 },
        { key: 'close-prepeak-huddle', label: 'Pre-shift huddle: forecast, positions, focus' },
        { key: 'close-prepeak-stations', label: 'Stations stocked, backups in place' },
        { key: 'close-prepeak-breaks', label: 'Meal breaks done or timed around the push' },
      ],
    },
    {
      key: 'peak',
      title: 'Peak',
      items: [
        { key: 'close-peak-run-floor', label: 'Run the shift from the floor, not the office' },
        { key: 'close-peak-staff-to-chart', label: 'Staff to the chart as the band climbs' },
        { key: 'close-peak-log-sales', label: 'Log sales and bodies every half hour' },
      ],
    },
    {
      key: 'post-peak',
      title: 'Post-Peak',
      items: [
        { key: 'close-deck-walk-3', label: 'Deck Walk 3 — after the push', deckWalk: 3 },
        { key: 'close-postpeak-phase-down', label: 'Phase down to the chart; cut in order' },
        { key: 'close-postpeak-breaks', label: 'Finish meal and rest breaks' },
        { key: 'close-postpeak-till-audit', label: 'Till audit' },
      ],
    },
    {
      key: 'pre-close',
      title: 'Pre-Close',
      items: [
        { key: 'close-preclose-stations', label: 'Pre-close by station, out of guest view' },
        { key: 'close-preclose-restock', label: "Restock for tomorrow's open" },
        { key: 'close-preclose-tills', label: 'Count tills with cashiers before they go' },
        { key: 'close-preclose-progress', label: 'Check progress on closing and detail tasks' },
      ],
    },
    {
      key: 'close',
      title: 'Close',
      items: [
        { key: 'close-doors-locked', label: 'Doors locked; signs off; patio secured' },
        { key: 'close-deck-walk-4', label: 'Deck Walk 4 — closing walk, every station', deckWalk: 4 },
        { key: 'close-market-case', label: 'Market case down; fish iced and dated' },
        { key: 'close-line-cooled', label: 'Line cooled, labeled, stored; equipment off' },
        { key: 'close-floors-dish', label: 'Floors, drains, dish and trash done' },
        { key: 'close-dining-restrooms', label: 'Dining room and restrooms reset for open' },
        { key: 'close-prep-list', label: "Tomorrow's prep list written" },
      ],
    },
    {
      key: 'daily-admin',
      title: 'Daily Admin',
      items: [
        { key: 'close-admin-tills-safe', label: 'Count tills and safe; prep deposit' },
        { key: 'close-admin-deposit-logs', label: 'Cash and deposit logs complete' },
        { key: 'close-admin-toast-eod', label: 'Run Toast end of day; tips reconciled' },
        { key: 'close-admin-clocked-out', label: 'All clocked out; timecard edits approved' },
        { key: 'close-admin-labor', label: 'Labor vs. schedule; note overages and why' },
        { key: 'close-admin-maintenance', label: 'Log repair and maintenance issues' },
        { key: 'close-admin-recap', label: 'Shift summary done; end of day recap sent' },
        { key: 'close-admin-alarm', label: 'Alarm set, building locked, leave in pairs' },
      ],
    },
  ],
};

export const TEMPLATES = { opening: OPENING, closing: CLOSING };
export const TEMPLATE_KEYS = Object.keys(TEMPLATES);
export const DEFAULT_TEMPLATE_KEY = 'opening';

/** A template's key, name and blurb — enough for a picker, without the items. */
export const templateSummaries = () =>
  TEMPLATE_KEYS.map((key) => ({
    key,
    name: TEMPLATES[key].name,
    blurb: TEMPLATES[key].blurb,
    totalItems: totalItems(key),
  }));

export function getTemplate(key) {
  return TEMPLATES[key] || TEMPLATES[DEFAULT_TEMPLATE_KEY];
}

export const isKnownTemplate = (key) => Object.hasOwn(TEMPLATES, key);

/** Every item in a template, flattened and indexed by key, in card order. */
const indexes = new Map(
  TEMPLATE_KEYS.map((templateKey) => [
    templateKey,
    new Map(
      TEMPLATES[templateKey].sections.flatMap((section) =>
        section.items.map((item) => [
          item.key,
          { ...item, sectionKey: section.key, sectionTitle: section.title },
        ])
      )
    ),
  ])
);

export const itemIndex = (templateKey) => indexes.get(templateKey) || indexes.get(DEFAULT_TEMPLATE_KEY);
export const totalItems = (templateKey) => itemIndex(templateKey).size;
export const isKnownItem = (templateKey, itemKey) => itemIndex(templateKey).has(itemKey);
export const findItem = (templateKey, itemKey) => itemIndex(templateKey).get(itemKey);
