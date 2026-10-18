// The open fire can change at any time (zooming in focuses a fire, zooming out returns to the overview: BRIEF-2
// decision 10). Answers carry the fire they were asked for (`incident_id`); readers keep only the open fire's
// answers, so a previous fire's official rows never show under the new one, even for the one render before the new
// answers are published. Answers that are not about one fire (`incident_id` null: a point or statewide query) pass.
export function forIncident<T extends { incident_id?: string | null }>(data: T | null | undefined, incidentId: string | null): T | null {
  if (!data) return null
  const id = data.incident_id ?? null
  return id == null || id === incidentId ? data : null
}
