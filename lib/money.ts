/** South African rand from cents: 123450 -> "R 1 234,50". */
export function formatZar(cents: number) {
  const neg = cents < 0; const abs = Math.abs(cents);
  const rand = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R ${rand},${String(abs % 100).padStart(2, "0")}`;
}
