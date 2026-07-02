import { Slot } from '@radix-ui/react-slot';
import { motion, useReducedMotion, type Transition } from 'motion/react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@client/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'end';

interface MenuCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  contentId: string;
}

const DropdownMenuContext = createContext<MenuCtx | null>(null);

function useMenuCtx(component: string) {
  const ctx = useContext(DropdownMenuContext);
  if (!ctx) throw new Error(`${component} must be used within <DropdownMenu>`);
  return ctx;
}

export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentId = `${useId()}-menu`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <DropdownMenuContext.Provider value={{ open, setOpen, triggerRef, panelRef, contentId }}>
      {children}
    </DropdownMenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  asChild,
  children,
}: {
  asChild?: boolean;
  children: ReactNode;
}) {
  const ctx = useMenuCtx('DropdownMenuTrigger');
  const Comp = asChild ? Slot : 'button';
  const setRef: RefCallback<HTMLElement> = (node) => {
    ctx.triggerRef.current = node;
  };

  return (
    <Comp
      ref={setRef}
      {...(!asChild && { type: 'button' as const })}
      aria-haspopup="menu"
      aria-expanded={ctx.open}
      aria-controls={ctx.contentId}
      onClick={() => ctx.setOpen(!ctx.open)}
    >
      {children}
    </Comp>
  );
}

export interface DropdownMenuContentProps {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
  children: ReactNode;
}

export function DropdownMenuContent({
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  alignOffset = 0,
  className,
  children,
}: DropdownMenuContentProps) {
  const ctx = useMenuCtx('DropdownMenuContent');
  const reduce = useReducedMotion() ?? false;
  const [style, setStyle] = useState<React.CSSProperties>({});
  // Mount once on first open and keep mounted so the close animation can play
  // (matches the pattern used by ui/select.tsx).
  const [mounted, setMounted] = useState(false);

  const setRefs: RefCallback<HTMLDivElement> = (node) => {
    ctx.panelRef.current = node;
  };

  useEffect(() => {
    if (ctx.open) setMounted(true);
  }, [ctx.open]);

  useLayoutEffect(() => {
    if (!ctx.open) return;
    const trigger = ctx.triggerRef.current;
    if (!trigger) return;
    const update = () => {
      const r = trigger.getBoundingClientRect();
      const next: React.CSSProperties = { position: 'fixed' };

      if (side === 'bottom') next.top = r.bottom + sideOffset;
      else if (side === 'top') next.bottom = window.innerHeight - r.top + sideOffset;
      else if (side === 'right') next.left = r.right + sideOffset;
      else next.right = window.innerWidth - r.left + sideOffset;

      if (side === 'top' || side === 'bottom') {
        if (align === 'start') next.left = r.left + alignOffset;
        else next.right = window.innerWidth - r.right + alignOffset;
      } else {
        if (align === 'start') next.top = r.top + alignOffset;
        else next.bottom = window.innerHeight - r.bottom + alignOffset;
      }

      setStyle(next);
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [ctx.open, ctx.triggerRef, side, align, sideOffset, alignOffset]);

  const originX = side === 'top' || side === 'bottom' ? (align === 'start' ? 'left' : 'right') : side === 'right' ? 'left' : 'right';
  const originY = side === 'bottom' ? 'top' : side === 'top' ? 'bottom' : align === 'start' ? 'top' : 'bottom';
  const slideDistance = 6;
  const hiddenOffset =
    side === 'bottom'
      ? { y: -slideDistance }
      : side === 'top'
        ? { y: slideDistance }
        : side === 'right'
          ? { x: -slideDistance }
          : { x: slideDistance };

  const transition: Transition = reduce
    ? { duration: 0.1 }
    : { type: 'spring', duration: 0.35, bounce: 0.15 };

  if (!mounted) return null;

  return createPortal(
    <motion.div
      ref={setRefs}
      id={ctx.contentId}
      role="menu"
      aria-hidden={!ctx.open}
      initial={false}
      animate={
        reduce
          ? { opacity: ctx.open ? 1 : 0 }
          : { opacity: ctx.open ? 1 : 0, scale: ctx.open ? 1 : 0.96, ...(ctx.open ? { x: 0, y: 0 } : hiddenOffset) }
      }
      transition={transition}
      style={{
        ...style,
        transformOrigin: `${originX} ${originY}`,
        pointerEvents: ctx.open ? 'auto' : 'none',
      }}
      className={cn(
        'z-50 min-w-[8rem] overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 text-zinc-900 shadow-sm shadow-black/[0.02] dark:border-border dark:bg-popover dark:text-popover-foreground dark:shadow-black/50',
        className,
      )}
    >
      {children}
    </motion.div>,
    document.body,
  );
}

export interface DropdownMenuItemProps {
  asChild?: boolean;
  className?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}

export function DropdownMenuItem({ asChild, className, onClick, children }: DropdownMenuItemProps) {
  const ctx = useMenuCtx('DropdownMenuItem');
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      {...(!asChild && { type: 'button' as const })}
      role="menuitem"
      onClick={(e: MouseEvent<HTMLElement>) => {
        onClick?.(e);
        ctx.setOpen(false);
      }}
      className={cn(
        'relative flex w-full cursor-default select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors',
        'hover:bg-zinc-200 hover:text-zinc-900 focus:bg-zinc-200 focus:text-zinc-900',
        'dark:hover:bg-primary/[0.12] dark:hover:text-foreground dark:focus:bg-primary/[0.12] dark:focus:text-foreground',
        className,
      )}
    >
      {children}
    </Comp>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div className={cn('-mx-1 my-1 h-px bg-muted', className)} />;
}
