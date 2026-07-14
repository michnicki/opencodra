import { ConfirmDialog } from 'codra';

// ConfirmDialog is an overlay (Radix dialog portaled to <body>). It takes an
// `open` prop, so it renders open statically. cfg.overrides pins cardMode
// "single" + a viewport so the centered dialog is captured inside the card.
export const DestructiveConfirm = () => (
  <ConfirmDialog
    open
    onOpenChange={() => {}}
    title="Remove repository?"
    description="Codra will stop reviewing pull requests for acme/web-app and delete its stored model configuration. This can't be undone."
    confirmLabel="Remove repository"
    cancelLabel="Keep it"
    confirmVariant="destructive"
    onConfirm={() => {}}
  />
);
