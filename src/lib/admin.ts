// Single source of truth for who can access /admin and its API routes.
// Kept as one exported constant (not duplicated per call site) so there's
// exactly one place to update if admin ownership ever changes.
export const ADMIN_USER_ID = "2f0be392-d997-4225-8da4-1ce434d05f89"; // Sophie
