import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  KeyRound,
  ShieldCheck,
  Clock,
  AlertCircle,
  CircleDashed,
  Plus,
  Save,
  X,
  Trash2,
  Pencil,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Skeleton } from '@client/components/shared/skeleton';
import { EmptyState } from '@client/components/shared/empty-state';
import { Card, CardContent } from '@client/components/ui/card';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Badge, type BadgeProps } from '@client/components/ui/badge';
import { Alert } from '@client/components/ui/alert';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import { cn } from '@client/lib/utils';
import type { CredentialStatus, VcsCredentialStatus, VcsCredentialStoreInput } from '@shared/schema';

// Four-state status presentation (D-05). Color is ALWAYS paired with an icon + text
// label so status is never conveyed by color alone (accessibility, per UI-SPEC §Color).
const STATUS_PRESENTATION: Record<
  CredentialStatus,
  { variant: NonNullable<BadgeProps['variant']>; icon: LucideIcon; label: string }
> = {
  valid: { variant: 'success', icon: ShieldCheck, label: 'Active' },
  'expiring-soon': { variant: 'warning', icon: Clock, label: 'Expires soon' },
  expired: { variant: 'danger', icon: AlertCircle, label: 'Expired' },
  missing: { variant: 'neutral', icon: CircleDashed, label: 'Not configured' },
};

function credentialKey(c: Pick<VcsCredentialStatus, 'workspace' | 'repoSlug'>) {
  return `${c.workspace}/${c.repoSlug}`;
}

function formatExpiry(tokenExpiresAt: string | null): string {
  if (!tokenExpiresAt) return 'No expiry recorded';
  const date = new Date(tokenExpiresAt);
  if (Number.isNaN(date.getTime())) return 'No expiry recorded';
  return `Expires ${date.toLocaleDateString()}`;
}

function toDateInputValue(tokenExpiresAt: string | null): string {
  if (!tokenExpiresAt) return '';
  const date = new Date(tokenExpiresAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

// The status badge is driven ENTIRELY by the server-precomputed `status` field — no
// client-side derivation and no live Bitbucket call (D-05 / D-13, review finding 9).
function StatusBadge({ status }: { status: CredentialStatus }) {
  const { variant, icon: Icon, label } = STATUS_PRESENTATION[status];
  return (
    <Badge variant={variant} className="gap-1">
      <Icon size={12} strokeWidth={2.4} className="-ml-0.5" aria-hidden="true" />
      {label}
    </Badge>
  );
}

interface CredentialFormValues {
  workspace: string;
  repoSlug: string;
  accessToken: string;
  webhookSecret: string;
  tokenExpiresAt: string;
  label: string;
}

interface CredentialFormProps {
  mode: 'add' | 'edit';
  initial: CredentialFormValues;
  submitting: boolean;
  onSubmit: (values: CredentialFormValues) => void;
  onCancel: () => void;
}

function CredentialForm({ mode, initial, submitting, onSubmit, onCancel }: CredentialFormProps) {
  const [values, setValues] = useState<CredentialFormValues>(initial);
  const isEdit = mode === 'edit';

  const setField = (field: keyof CredentialFormValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
  };

  // New credentials require both secrets + the identity keys. On rotate/edit the
  // secrets may be left blank to keep the stored ciphertext (D-11), so only the
  // (fixed) identity keys are required.
  const canSubmit = isEdit
    ? Boolean(values.workspace.trim() && values.repoSlug.trim())
    : Boolean(
        values.workspace.trim() &&
          values.repoSlug.trim() &&
          values.accessToken.trim() &&
          values.webhookSecret.trim(),
      );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !submitting) onSubmit(values);
      }}
    >
      {!isEdit && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-foreground">Workspace</span>
            <Input
              value={values.workspace}
              onChange={setField('workspace')}
              placeholder="my-workspace"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-foreground">Repository slug</span>
            <Input
              value={values.repoSlug}
              onChange={setField('repoSlug')}
              placeholder="my-repo"
              autoComplete="off"
            />
          </label>
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-foreground">Access token</span>
        <Input
          type="password"
          value={values.accessToken}
          onChange={setField('accessToken')}
          placeholder={isEdit ? 'Enter a new token to replace the stored one' : 'Repository or Workspace Access Token'}
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">
          Bearer token, not an app password. Stored encrypted; never shown again.
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-foreground">Webhook secret</span>
        <Input
          type="password"
          value={values.webhookSecret}
          onChange={setField('webhookSecret')}
          placeholder={isEdit ? 'Enter a new secret to replace the stored one' : 'Per-repo webhook secret'}
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">Used to verify incoming Bitbucket webhooks.</span>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-foreground">Token expiry (optional)</span>
          <Input type="date" value={values.tokenExpiresAt} onChange={setField('tokenExpiresAt')} />
          <span className="text-xs text-muted-foreground">
            Copy from Bitbucket's token screen. Leave blank if the token has no expiry.
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-foreground">Label (optional)</span>
          <Input
            value={values.label}
            onChange={setField('label')}
            placeholder="e.g. reviewer bot"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || submitting} className="gap-2">
          <Save size={14} />
          {isEdit ? 'Save changes' : 'Store credential'}
        </Button>
      </div>
    </form>
  );
}

const EMPTY_FORM: CredentialFormValues = {
  workspace: '',
  repoSlug: '',
  accessToken: '',
  webhookSecret: '',
  tokenExpiresAt: '',
  label: '',
};

export function VcsCredentialsPage() {
  const [credentials, setCredentials] = useState<VcsCredentialStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VcsCredentialStatus | null>(null);

  const load = () => {
    setLoading(true);
    api
      .getVcsCredentials()
      .then((res) => {
        setCredentials(Array.isArray(res?.credentials) ? res.credentials : []);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load credentials.');
        setLoading(false);
      });
  };

  useEffect(() => { load(); }, []);

  const editingCredential = useMemo(
    () => credentials.find((c) => credentialKey(c) === editingKey) ?? null,
    [credentials, editingKey],
  );

  const closeForms = () => {
    setAdding(false);
    setEditingKey(null);
  };

  const handleSubmit = async (mode: 'add' | 'edit', values: CredentialFormValues) => {
    setSubmitting(true);
    const workspace = values.workspace.trim();
    const repoSlug = values.repoSlug.trim();
    const tid = toast.loading('Saving credential…');

    // D-11 rotate-in-place: omit a secret field when left blank so the stored
    // ciphertext is preserved. On new credentials both secrets are required (form-gated).
    const input: VcsCredentialStoreInput = {
      vcsProvider: 'bitbucket',
      workspace,
      repoSlug,
      label: values.label.trim() ? values.label.trim() : null,
    };
    if (values.accessToken.trim()) input.accessToken = values.accessToken;
    if (values.webhookSecret.trim()) input.webhookSecret = values.webhookSecret;

    // IN-02: the date input is date-only (YYYY-MM-DD), so re-sending an untouched expiry that
    // originally carried a time component would truncate it (e.g. 15:30 -> 00:00, shifting the
    // effective expiry backward by up to a day). On edit, only include tokenExpiresAt when the
    // date input actually changed from the stored value; an unchanged expiry is omitted so the
    // server leaves it untouched (D-11). On add, always send it.
    const currentExpiry = values.tokenExpiresAt.trim();
    const originalExpiry = mode === 'edit' ? toDateInputValue(editingCredential?.tokenExpiresAt ?? null) : '';
    if (mode !== 'edit' || currentExpiry !== originalExpiry) {
      input.tokenExpiresAt = currentExpiry ? currentExpiry : null;
    }

    try {
      const { credential } = await api.storeVcsCredential(input);
      setCredentials((current) => {
        const next = current.filter((c) => credentialKey(c) !== credentialKey(credential));
        return [...next, credential].sort((a, b) => credentialKey(a).localeCompare(credentialKey(b)));
      });
      closeForms();
      if (mode === 'edit') {
        toast.success('Credential updated', { id: tid, description: 'The stored token and secret were replaced.' });
      } else {
        toast.success('Credential stored', { id: tid, description: `${workspace}/${repoSlug} is ready for review.` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Your changes were not applied. Please try again.';
      setError(msg);
      toast.error('Could not save credential', { id: tid, description: 'Your changes were not applied. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const tid = toast.loading('Removing credential…');
    try {
      await api.deleteVcsCredential({
        vcsProvider: target.vcsProvider,
        workspace: target.workspace,
        repoSlug: target.repoSlug,
      });
      setCredentials((current) => current.filter((c) => credentialKey(c) !== credentialKey(target)));
      toast.success('Credential removed', {
        id: tid,
        description: `${target.workspace}/${target.repoSlug} no longer has a stored token.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not remove the credential. Please try again.';
      setError(msg);
      toast.error('Could not save credential', { id: tid, description: 'Your changes were not applied. Please try again.' });
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <section className="page-enter flex flex-col gap-5">
      <PageHeader
        title="Credentials"
        actions={
          !adding && !editingKey ? (
            <Button size="sm" className="gap-2" onClick={() => { setAdding(true); setEditingKey(null); }}>
              <Plus size={14} />
              Add credential
            </Button>
          ) : undefined
        }
      />

      {error && <Alert variant="destructive">{error}</Alert>}

      {adding && (
        <Card>
          <CardContent className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Store a Bitbucket credential</h2>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Cancel" onClick={closeForms}>
                <X size={15} />
              </Button>
            </div>
            <CredentialForm
              mode="add"
              initial={EMPTY_FORM}
              submitting={submitting}
              onSubmit={(values) => handleSubmit('add', values)}
              onCancel={closeForms}
            />
          </CardContent>
        </Card>
      )}

      {loading && credentials.length === 0 ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="surface px-4 py-4">
              <Skeleton height={20} />
            </div>
          ))}
        </div>
      ) : credentials.length === 0 && !adding ? (
        <EmptyState
          icon={<KeyRound />}
          title="No Bitbucket credentials yet"
          description="Add a Repository or Workspace Access Token and webhook secret so Codra can review this repo's pull requests. Nothing is sent to Bitbucket until a review runs."
          action={{ label: 'Add credential', onClick: () => setAdding(true) }}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5">
          {credentials.map((credential) => {
            const key = credentialKey(credential);
            const isEditing = editingKey === key;
            return (
              <Card key={key}>
                <CardContent className="p-5">
                  <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm text-foreground">{key}</span>
                        <StatusBadge status={credential.status} />
                        {credential.label && (
                          <span className="text-xs text-muted-foreground">{credential.label}</span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="text-xs text-muted-foreground">{formatExpiry(credential.tokenExpiresAt)}</span>
                        <span className="text-xs text-muted-foreground">
                          {credential.hasToken ? 'Token stored' : 'No token stored'}
                          {' · '}
                          {credential.hasWebhookSecret ? 'Webhook secret stored' : 'No webhook secret stored'}
                        </span>
                      </div>
                    </div>

                    <div className={cn('flex flex-wrap items-center gap-2 lg:justify-end', isEditing && 'hidden')}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={() => { setEditingKey(key); setAdding(false); }}
                      >
                        <Pencil size={13} />
                        Edit
                      </Button>
                      <Button
                        variant="destructive-outline"
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={() => setDeleteTarget(credential)}
                      >
                        <Trash2 size={13} />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {isEditing && editingCredential && (
                    <div className="mt-4 border-t border-border/60 pt-4">
                      <CredentialForm
                        mode="edit"
                        initial={{
                          workspace: editingCredential.workspace,
                          repoSlug: editingCredential.repoSlug,
                          accessToken: '',
                          webhookSecret: '',
                          tokenExpiresAt: toDateInputValue(editingCredential.tokenExpiresAt),
                          label: editingCredential.label ?? '',
                        }}
                        submitting={submitting}
                        onSubmit={(values) => handleSubmit('edit', values)}
                        onCancel={closeForms}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete credential"
        description={
          deleteTarget
            ? `Remove the stored access token and webhook secret for ${deleteTarget.workspace}/${deleteTarget.repoSlug}? Codra will stop authenticating for this repo until you add them again. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        confirmVariant="destructive-outline"
        onConfirm={handleDelete}
      />
    </section>
  );
}
