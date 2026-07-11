import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { Button, type ButtonProps } from '@client/components/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonProps['variant'];
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  confirmVariant = 'default',
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/75 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in data-[state=closed]:fade-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--warning-bg)] text-[var(--warning)]">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-foreground">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {description}
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <Button variant="outline">{cancelLabel}</Button>
            </Dialog.Close>
            <Button
              variant={confirmVariant}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
