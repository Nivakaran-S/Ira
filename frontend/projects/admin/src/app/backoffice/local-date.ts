/** The date as the browser's own calendar shows it; toISOString() gives the UTC day, which is still yesterday in Colombo until 05:30. */
export const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
