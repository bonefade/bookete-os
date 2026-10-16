export const ValidationError = class extends Error {
  constructor(field, message) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
};
/** A write lost a race: the record changed between read and commit. Use cases retry; the message is for when they give up. */
export const ConflictError = class extends Error {
  constructor() {
    super("Der Datensatz wurde gerade von jemand anderem ge\xE4ndert. Bitte nochmal versuchen.");
    this.name = "ConflictError";
  }
};
