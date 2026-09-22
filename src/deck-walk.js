/**
 * The Deck Walk route: a figure eight, walked four times a shift.
 *
 * Two loops crossing at the Pass — back of house first (stops 1-5), then the
 * front (stops 6-10) — so the walk starts and ends in the same place and covers
 * the building in the same order every time. This is reference material shown
 * in the app; it holds no state.
 */

export const WALK_RULES = {
  headline: 'See it, fix it.',
  lines: ["Can't fix it now, assign it.", "Can't assign it, write it down."],
  cadence: 'Four walks a shift: shift start, before the push, after the push, and at close or transition.',
  route: 'Two loops, one crossing. Back of house first, then the front. Same path every time.',
};

export const LOOPS = [
  { key: 'boh', number: 1, name: 'Back of House', stops: 'Stops 1 to 5' },
  { key: 'foh', number: 2, name: 'Front of House', stops: 'Stops 6 to 10' },
];

/** In walk order. `stop` is what's printed on the route diagram. */
export const STATIONS = [
  {
    stop: 'P',
    key: 'pass',
    name: 'The Pass',
    note: 'start + finish',
    loop: 'cross',
    checks: [
      'Ticket times in range',
      'Plates to spec, clean rims',
      'Nothing dying in the window',
      'Expo calling, runners moving',
      'Kitchen and front talking',
    ],
  },
  {
    stop: '1',
    key: 'line',
    name: 'The Line',
    loop: 'boh',
    checks: [
      'Right positions for the band',
      'Stocked, backups in place',
      'Fryer oil good; grill clean',
      'Reach-ins at 41°F or below',
      'Gloves, handwashing, sanitizer',
      'Clean as you go',
    ],
  },
  {
    stop: '2',
    key: 'prep-dish',
    name: 'Prep & Dish',
    loop: 'boh',
    checks: [
      'Prep on pace for the forecast',
      'Everything labeled and dated',
      'Dish caught up; sanitizer tested',
      'Floors dry, mats down',
      'Knives and boards stored right',
    ],
  },
  {
    stop: '3',
    key: 'back-door',
    name: 'Back Door',
    note: 'receiving',
    loop: 'boh',
    checks: [
      'Door closed and locked',
      'Deliveries put away; fish on ice',
      'Dumpster area clean, lids shut',
      'No boxes or trash staged',
      'Mop sink and chemicals in order',
    ],
  },
  {
    stop: '4',
    key: 'walk-in',
    name: 'Walk-in & Freezer',
    loop: 'boh',
    checks: [
      'Cooler 41°F; freezer 0°F',
      'Fish on ice, drained, covered',
      'FIFO; every item dated',
      'Raw stored below ready to eat',
      'Product 6 inches off the floor',
      'Organized, floor clean',
    ],
  },
  {
    stop: '5',
    key: 'storage-office',
    name: 'Storage & Office',
    loop: 'boh',
    checks: [
      'Organized; FIFO; boxes flat',
      'Chemicals away from food',
      'Office and safe locked',
      'Clock-ins match the schedule',
      'Breaks on track',
      'Sales vs. forecast; right band',
    ],
  },
  {
    stop: '6',
    key: 'counter-bar',
    name: 'Counter & Bar',
    loop: 'foh',
    checks: [
      'Greeting fast and friendly',
      'Order read back; drink offered',
      'Line buster out when band says',
      'Bar staffed, stocked, clean',
      'Second drink offered',
      'Menu boards and 86s current',
    ],
  },
  {
    stop: '7',
    key: 'market-case',
    name: 'Market Case',
    loop: 'foh',
    checks: [
      'Iced, full and fronted',
      'Tags and prices correct',
      'Glass clean inside and out',
      'Product fresh and rotated',
      'Scale and wrap station clean',
    ],
  },
  {
    stop: '8',
    key: 'dining-room',
    name: 'Dining Room',
    loop: 'foh',
    checks: [
      'Tables bussed and wiped fast',
      'Floors swept, no spills',
      'Sauce and utensils stocked',
      'Music and temperature right',
      'Guests checked on',
      'Team in uniform, good energy',
    ],
  },
  {
    stop: '9',
    key: 'restrooms',
    name: 'Restrooms',
    loop: 'foh',
    checks: [
      'Soap, paper and towels stocked',
      'Clean and dry; no odor',
      'Trash emptied',
      'Mirrors and fixtures wiped',
      'Lights and locks working',
    ],
  },
  {
    stop: '10',
    key: 'patio-outside',
    name: 'Patio & Outside',
    loop: 'foh',
    checks: [
      'Tables, umbrellas, heaters set',
      'Dog bowls filled',
      'Entry glass and doors clean',
      'Sidewalk and lot litter free',
      'Signs and lights working',
      'Trash cans not overflowing',
    ],
  },
];

export const deckWalkGuide = () => ({ rules: WALK_RULES, loops: LOOPS, stations: STATIONS });
