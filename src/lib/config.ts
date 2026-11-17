// shortcut: tuned for the 2×2 checker targets in the Bua survey (~0.9 m square); expose in the UI if other target sizes are used.
export const QUAD_M = 0.45; // one checker quadrant, metres
export const SEARCH_R = 450; // px around the projected point; covers ~1 m GCP coordinate error at 65 m AGL
export const MIN_SCORE = 0.5; // below this, a detection is flagged for review
export const TEMPLATE_M = 1.2; // ground radius of the patch copied from a seed mark for template matching, metres
export const MIN_NCC = 0.6; // template matches below this are dropped
export const REVIEW_NCC = 0.8; // template matches below this are flagged for review (true matches on Bua: 0.87–0.97)
