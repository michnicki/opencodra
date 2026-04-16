import { Zap } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-border/40 py-12 mt-20">
      <div className="container mx-auto px-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8 md:gap-4 text-center md:text-left">
          {/* Brand & Logo */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-primary/20">
              <Zap size={10} className="text-primary" />
            </div>
            <span className="text-[10px] font-black tracking-[0.2em] text-foreground uppercase pt-0.5">Codra</span>
          </div>

          {/* Essential Links */}
          <div className="flex items-center gap-10 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">
            <a href="https://github.com/devarshishimpi/codra" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">GitHub</a>
            <a href="#" className="hover:text-foreground transition-colors">Documentation</a>
            <a href="#" className="hover:text-foreground transition-colors">Changelog</a>
          </div>
          
          {/* Credit with Love */}
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground/40">
            Built with love by{' '}
            <a 
              href="https://devarshi.dev" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-foreground hover:text-primary transition-all font-semibold"
            >
              Devarshi Shimpi
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
