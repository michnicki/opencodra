import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { ClipboardList } from 'lucide-react';
import type { JobDetail } from '@shared/schema';

const safeRehypePlugins = [rehypeRaw, rehypeSanitize];

interface JobReviewOverviewProps {
  job: JobDetail;
}

export function JobReviewOverview({ job }: JobReviewOverviewProps) {
  // summary_markdown is now the single source of truth: runFinalizePhase always populates it
  // (recap-only at minimum) on a completed job, so its absence means there is nothing to show.
  if (!job.summaryMarkdown) return null;

  const renderSummary = () => {
    if (!job.summaryMarkdown) return '';
    let content = job.summaryMarkdown.replace(/^(✅ \*\*Approved\*\*|💬 \*\*Comments posted\*\*)\n\n/, '').trim();

    // Strip only the "### ... (Open)Codra Review" heading, keep the intro sentence.
    // Matches both new "OpenCodra Review" and legacy "Codra Review" headings so
    // comments posted before the rebrand still render correctly.
    const stripHeader = (md: string) => md
      .replace(/^###\s*(<picture>[\s\S]*?<\/picture>|💡)\s*(?:Open)?Codra Review\s*\n+/, '')
      .trim();

    if (content.startsWith('### 💡 OpenCodra Review') || content.startsWith('### 💡 Codra Review') || content.includes('OpenCodra Review') || content.includes('Codra Review')) {
      return stripHeader(content);
    }

    return stripHeader(content);
  };

  return (
    <div className="surface surface-static surface-static-shadow overflow-hidden mb-6">
      {/* Header */}
      <div className="flex items-center px-5 py-4 border-b border-border gap-2.5">
        <ClipboardList size={14} strokeWidth={1.75} className="text-primary" />
        <span className="text-sm font-semibold text-foreground">Review Overview</span>
      </div>

      {/* Summary */}
      <div className="px-5 py-5">
        <div className="prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={safeRehypePlugins}>
            {renderSummary()}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
