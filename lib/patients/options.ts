// Choices for patient forms. Kept apart from the Zod schemas so client forms can import them without pulling Zod into the browser bundle.
export const LANGUAGES = [
  ["en", "English"], ["af", "Afrikaans"], ["zu", "isiZulu"], ["xh", "isiXhosa"], ["st", "Sesotho"], ["tn", "Setswana"],
  ["nso", "Sepedi"], ["ts", "Xitsonga"], ["ss", "siSwati"], ["ve", "Tshivenda"], ["nr", "isiNdebele"], ["other", "Another language"],
] as const;
export const PAYERS = [["self", "Self-pay"], ["medical_aid", "Medical aid"], ["split", "Part self-pay, part medical aid"]] as const;
