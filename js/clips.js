// ─────────────────────────────────────────────────────────────────────────────
//  Avatar + sign configuration. This is the only file you edit to add signs.
//
//  Adding a sign:
//    1. Export the animation from Blender as a .glb (see README → "Adding a clip").
//    2. Save it in assets/clips/  (e.g. assets/clips/summer.glb).
//    3. Give the sign below a  file: 'assets/clips/summer.glb'  line.
//
//  A sign with no  file  (or whose file is missing) shows as "Coming soon" in
//  the Dictionary and is skipped — and reported — by Translate.
// ─────────────────────────────────────────────────────────────────────────────

export const AVATAR = {
  // Optional. A separate .glb holding just the character (mesh + rig), e.g.
  // 'assets/avatar/character.glb'. Leave as null to use the first available
  // clip's .glb as the character — with one export you only need summer.glb.
  character: null,

  // Camera framing, as fractions of the character's height.
  //   focusY: where the camera looks (0 = feet, 1 = top of head)
  //   height: how much of the character's height is visible
  //   width:  how much of the height the view must fit horizontally (arms out)
  frame: { focusY: 0.69, height: 0.62, width: 0.50 },
};

// id       → unique key, lowercase, no spaces
// en       → label shown in the app
// file     → path to the clip .glb (leave out until the clip exists)
// tag      → dictionary category
// aliases  → extra words Translate should map to this sign
// clip     → (optional) name of the animation inside the .glb; default = first one
export const SIGNS = [
  { id: 'summer',      en: 'Summer',      tag: 'Seasons', file: 'assets/clips/summer.glb' },
  { id: 'do',          en: 'Do',          tag: 'Demo line', file: 'assets/clips/do.glb' },
  { id: 'your',        en: 'Your',        tag: 'Demo line', file: 'assets/clips/your.glb' },
  { id: 'best',        en: 'Best',        tag: 'Demo line', file: 'assets/clips/best.glb' },
  { id: 'competition', en: 'Competition', tag: 'Demo line', file: 'assets/clips/competition.glb' },
  { id: 'hello',       en: 'Hello',       tag: 'Greetings', aliases: ['hi'] },
  { id: 'thankyou',    en: 'Thank you',   tag: 'Greetings', aliases: ['thanks'] },
  { id: 'please',      en: 'Please',      tag: 'Greetings' },
  { id: 'yes',         en: 'Yes',         tag: 'Basics' },
  { id: 'no',          en: 'No',          tag: 'Basics' },
  { id: 'help',        en: 'Help',        tag: 'Basics' },
  { id: 'water',       en: 'Water',       tag: 'Daily life' },
  { id: 'friend',      en: 'Friend',      tag: 'People' },
  { id: 'family',      en: 'Family',      tag: 'People' },
  { id: 'love',        en: 'Love',        tag: 'Emotions' },
];

export const clipUrl = (sign) => sign.file || null;
