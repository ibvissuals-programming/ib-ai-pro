// Shared boot-state flag.
// Set to "degraded" if any module fails to load during startup.
// Read by health endpoints to surface partial-boot conditions.

let state: "success" | "degraded" = "success";

export function setBootDegraded(): void {
  state = "degraded";
}

export function getBootState(): "success" | "degraded" {
  return state;
}
