import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@client/components/ui/card';
import { Badge } from '@client/components/ui/badge';
import { cn } from '@client/lib/utils';
import type { JobDetail } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';
import { severityConfig } from './constants';

interface JobReviewOverviewProps {
  job: JobDetail;
}

export function JobReviewOverview({ job }: JobReviewOverviewProps) {
  const hasOverview = !!(job.summaryMarkdown || job.overallCorrectness || (job.overallConfidenceScore !== undefined && job.overallConfidenceScore !== null));
  if (!hasOverview) return null;

  const allComments = job.files.flatMap((f) => f.parsedComments);
  const sevCounts = Object.fromEntries(
    reviewSeverities.map((s) => [s, allComments.filter((c) => c.severity === s).length]),
  );

  const renderSummary = () => {
    if (!job.summaryMarkdown) return '';
    let content = job.summaryMarkdown.replace(/^(✅ \*\*Approved\*\*|💬 \*\*Comments posted\*\*)\n\n/, '').trim();
    if (content.startsWith('### 💡 Codra Review')) return content;
    
    const shortSha = job.commitSha.slice(0, 10);
    return `### 💡 Codra Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${shortSha}\`\n\n<details>\n<summary>ℹ️ About Codra</summary>\n\n<br/>\n\n[Your team has set up Codra to review pull requests in this repo](https://codra.devarshi.dev/repos). Reviews are triggered when you:\n\n- **Open** a pull request for review\n- **Mark** a draft as ready\n- **Comment** "@codra-app review"\n\nIf Codra has suggestions, it will comment; otherwise it will react with 👍.\n\nCodra can also answer questions or update the PR. Try commenting "@codra-app address that feedback".\n\n</details>\n\n---\n\n${content}`;
  };

  return (
    <Card className="premium-card border-none shadow-xl shadow-slate-200/50 mb-6 overflow-hidden relative">
      <div className="absolute top-0 right-0 p-4 opacity-10">
        <Sparkles size={60} />
      </div>
      <CardHeader className="border-b border-border/40 bg-card/30 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl font-bold tracking-tight">Review Overview</CardTitle>
          <div className="flex items-center gap-3">
            {job.overallCorrectness && (
              <Badge className={cn(
                "px-3 py-1 rounded-full border shadow-sm transition-all text-[11px] font-bold uppercase tracking-wider",
                job.overallCorrectness.toLowerCase().includes('incorrect') 
                  ? "bg-red-50 text-red-700 border-red-200" 
                  : "bg-emerald-50 text-emerald-700 border-emerald-200"
              )}>
                {job.overallCorrectness}
              </Badge>
            )}
            {(job.overallConfidenceScore !== undefined && job.overallConfidenceScore !== null) && (
              <div className="flex flex-col items-end mr-2">
                <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground/60 leading-none mb-1">Confidence</span>
                <span className="text-sm font-bold text-foreground leading-none">{(Number(job.overallConfidenceScore) * 100).toFixed(0)}%</span>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-6 relative">
        <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-strong:text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {renderSummary()}
          </ReactMarkdown>
        </div>

        {/* Severity Summary Triage */}
        <div className="mt-8 pt-6 border-t border-border/40">
          <div className="flex items-center gap-2 mb-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Priority Triage</p>
            <div className="h-px flex-1 bg-border/20" />
          </div>
          <div className="flex flex-wrap gap-2.5">
            {reviewSeverities.map((sev) => {
              const count = sevCounts[sev] || 0;
              const cfg = severityConfig[sev];
              if (count === 0 && sev !== 'nit') return null;
              
              return (
                <div 
                  key={sev}
                  className={cn(
                    'group flex items-center gap-3 rounded-xl border px-3.5 py-2 transition-all duration-300',
                    count > 0 ? `${cfg?.bg} ${cfg?.border} shadow-sm` : 'bg-muted/30 border-border/30 opacity-60'
                  )}
                >
                  {cfg?.svg ? (
                    <img src={cfg.svg} alt={sev} className="w-[18px] h-[18px] transition-transform group-hover:scale-110" />
                  ) : (
                    <cfg.icon size={15} className={cn('transition-transform group-hover:scale-110', count > 0 ? cfg?.iconColor : 'text-muted-foreground')} />
                  )}
                  <div className="flex flex-col leading-none">
                    <span className={cn('text-[9px] font-bold uppercase tracking-wider mb-0.5', count > 0 ? cfg?.text : 'text-muted-foreground')}>{sev}</span>
                    <span className={cn('text-lg font-bold font-mono', count > 0 ? 'text-foreground' : 'text-muted-foreground/50')}>{count}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
