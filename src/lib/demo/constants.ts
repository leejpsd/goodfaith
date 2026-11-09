// The one repository and test account the demo acts through.
export const DEMO = { owner: 'leejpsd', repo: 'goodfaith-demo', contributor: 'leejpsd-goodfaith' } as const;

// Earlier pull requests hold real elapsed time for the video, so no visitor can act on them.
export const FIRST_TRY_NUMBER = 6;

// Waits at the gate through judging, so the console's first page always has something on it.
// It holds no money and has no deadline, and no visitor can act on it from the try page.
export const KEPT_WAITING_NUMBER = 14;
