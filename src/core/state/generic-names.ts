/**
 * Shared vocabulary of uninformative element names.
 *
 * Lives in its own module because both the parser and the enrichment pass
 * need it, and the enrichment pass now sits outside StateParser.
 */
/**
 * Names that are too generic to uniquely identify an element.
 * When one of these is encountered, the parser tries to prefix it with
 * context from the nearest meaningful parent/ancestor.
 */
export const GENERIC_NAMES = new Set([
  // German
  'mehr erfahren',
  'weiter',
  'klick hier',
  'hier klicken',
  'auswählen',
  'tarif auswählen',
  'jetzt auswählen',
  'jetzt wählen',
  'wählen',
  'anzeigen',
  'anmelden',
  'bestätigen',
  'abbrechen',
  'schließen',
  'ja',
  'nein',
  'ok',
  'button',
  'link',
  // English
  'more info',
  'details',
  'next',
  'next step',
  'click here',
  'select',
  'choose',
  'show',
  'hide',
  'confirm',
  'cancel',
  'close',
  'yes',
  'no',
  'learn more',
  'read more',
  'view',
  'open',
  'submit',
]);

export function isGenericName(name: string): boolean {
  return name.length < 3 || GENERIC_NAMES.has(name.toLowerCase().trim());
}
