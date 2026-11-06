// Copying text. navigator.clipboard exists only in a secure context, and this page is
// reached over plain http on the tailnet, so the old selection route is the one that runs
// there and has to work too.

export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Refused, which a browser may do even where the API exists: try the old way.
    }
  }
  return copyThroughSelection(text);
}

function copyThroughSelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
