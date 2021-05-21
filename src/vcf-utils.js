export const PILEUP_COLORS = {
  VARIANT: [0.3, 0.3, 0.3, 0.6], // gray for the variant background
  LINE: [0.9, 0.9, 0.9, 1], // gray for the variant background
  INSERTION: [0.6, 0.6, 0.0, 0.7],
  DELETION: [1, 0.0, 0.0, 0.55],
  INVERSION: [0.68, 0.23, 0.87, 0.8],
  DUPLICATION: [0.27, 0.64, 0.09, 0.8],
  BLACK: [0, 0, 0, 1],
  BLACK_05: [0, 0, 0, 0.5],
  WHITE: [1, 1, 1, 1],
};

export const PILEUP_COLOR_IXS = {};
Object.keys(PILEUP_COLORS).map((x, i) => {
  PILEUP_COLOR_IXS[x] = i;

  return null;
});
