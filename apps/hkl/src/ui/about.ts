// About modal: the "About" link on the version line opens #aboutDialog
// (markup and copy live in index.html).

export function initAboutUi(): void {
  const dlg = document.getElementById('aboutDialog') as HTMLDialogElement | null;
  document.getElementById('aboutLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    dlg?.showModal();
  });
  document.getElementById('aboutClose')?.addEventListener('click', () => dlg?.close());
}
