/**
 * The colours an operator can give an agent.
 *
 * One module, imported by the server and served to the browser in `/api/state`,
 * so the list the picker draws and the list the endpoint validates against are
 * the same list. A second copy in the UI would drift, and the failure would be
 * silent: a swatch that saves and then does not appear.
 *
 * Every value is a literal hex rather than a theme variable. A colour an
 * operator chose has to be the colour they see, on both themes and on every
 * viewer's screen — a themed value would quietly mean something else in light
 * mode, and "who is in the green shirt" would stop being answerable.
 */

/**
 * Shirts. Twenty, spread around the hue wheel, tuned per band rather than
 * generated flat: a fixed saturation makes the yellow-greens glare next to the
 * blues, so the greens and teals are calmed and the ambers darkened.
 *
 * The five the floor already used are members at their exact values, so an
 * agent that had one keeps it when shirts become explicit.
 */
export const SHIRTS = [
  '#f08a80', '#f0a17f', '#e8b339', '#d8c53c', '#b0c757',
  '#8fc757', '#7fc56d', '#6dc576', '#6cc48a', '#64c4a7',
  '#64c4c4', '#62b6da', '#7aa2ff', '#7a88ff', '#b39bfa',
  '#c796f8', '#d488e7', '#e77edc', '#e77ebd', '#e77e9e',
];

/**
 * Which shirt a desk gets the first time it is seen.
 *
 * This is the arrival order the floor has always used — blue, purple, green,
 * amber, red — not the order of the list above, which is sorted by hue. Seat
 * colour was how a desk stayed recognisable across the room, and that survives
 * as the *default*; the operator can now override it.
 */
const BY_SEAT = ['#7aa2ff', '#b39bfa', '#6cc48a', '#e8b339', '#f08a80'];
export const shirtForSeat = (seat) => BY_SEAT[((seat ?? 0) % BY_SEAT.length + BY_SEAT.length) % BY_SEAT.length];

/**
 * Hair, lightest first. Six, ending at the brown every agent starts with.
 *
 * Ordered by computed luminance rather than by name, which is why light brown
 * sits ahead of auburn — auburn is the redder of the two but very slightly
 * darker, and a row that jumps around in lightness reads as unsorted.
 */
export const HAIRS = [
  '#e8c99b',  // light blonde
  '#d9a441',  // golden blonde
  '#9a6a3f',  // light brown
  '#b1583a',  // auburn
  '#7a4f33',  // medium brown
  '#5a4130',  // dark brown — the default
];

/**
 * Skin. The first swatch is the neutral placeholder grey every agent starts
 * with; the five after it are the Unicode emoji skin tone modifiers
 * (U+1F3FB–U+1F3FF), light to dark, at the exact values Twemoji fills them
 * with — read from the modifier swatch SVGs, which are literally single-colour
 * squares of these tones.
 *
 * Deliberately not invented here. These derive from the Fitzpatrick scale by
 * way of the Unicode emoji standard, which is the same basis Apple, Google and
 * Slack all key their pickers off, and it is a list we can point at rather than
 * defend on taste. Leading with the neutral grey follows what emoji pickers do
 * with their non-human default: it is the "nobody has chosen" state, so it sits
 * first rather than in luminance order with the rest.
 */
export const SKINS = [
  '#a9afb8',  // neutral placeholder — the default
  '#f7dece',  // light            U+1F3FB
  '#f3d2a2',  // medium-light     U+1F3FC
  '#d5ab88',  // medium           U+1F3FD
  '#af7e57',  // medium-dark      U+1F3FE
  '#7c533e',  // dark             U+1F3FF
];

export const DEFAULT_HAIR = HAIRS[HAIRS.length - 1];
export const DEFAULT_SKIN = SKINS[0];

/** What the browser is sent, and what the endpoint checks against. */
export const PALETTE = { shirt: SHIRTS, hair: HAIRS, skin: SKINS };
