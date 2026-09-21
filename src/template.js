/**
 * The Captain's Log checklist template.
 *
 * This is the shift card in code form. Item `key`s are stable identifiers that
 * completed checks are stored against, so DO NOT rename a key once a shift has
 * been logged with it -- change the `label` freely, but treat keys as permanent.
 *
 * When you add, remove or re-key items, bump TEMPLATE_VERSION. Each shift
 * records the version it was run under so old shifts keep rendering correctly.
 */

export const TEMPLATE_VERSION = 1;

export const SECTIONS = [
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
    deckWalk: { number: 1, title: 'Deck Walk 1 — shift start' },
    items: [
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
    deckWalk: { number: 2, title: 'Deck Walk 2 — before the push' },
    items: [
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
    deckWalk: { number: 3, title: 'Deck Walk 3 — after the push' },
    items: [
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
    deckWalk: { number: 4, title: 'Deck Walk 4 — with incoming manager' },
    items: [
      { key: 'transition-huddle', label: 'Huddle: sales, labor, 86s, open issues' },
      { key: 'transition-safe-count', label: 'Count safe with incoming manager' },
      { key: 'transition-deposit-log', label: 'Cash and deposit log complete' },
      { key: 'transition-recap', label: 'Finish shift summary; send shift recap' },
    ],
  },
];

/** Every item key in the template, flattened, in card order. */
export const ITEM_INDEX = new Map(
  SECTIONS.flatMap((section) =>
    section.items.map((item) => [item.key, { ...item, sectionKey: section.key, sectionTitle: section.title }])
  )
);

export const TOTAL_ITEMS = ITEM_INDEX.size;

export function isKnownItem(key) {
  return ITEM_INDEX.has(key);
}
