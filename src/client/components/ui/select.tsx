import { Check, ChevronDown } from 'lucide-react';
import { motion, type Transition, useReducedMotion, type Variants } from 'motion/react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@client/lib/utils';
import { EASE_OUT } from '@client/lib/ease';

// Spring with bounce powers the unfold/separation; per-property timings in the
// content choreograph it. See the `animate`/`transition` props on the panel below.
const CHEVRON_TRANSITION: Transition = { type: 'spring', duration: 0.4, bounce: 0.3 };

const LIST_VARIANTS: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
};
const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -6, filter: 'blur(3px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)' },
};

type Placement = 'bottom' | 'top';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  className?: string;
  triggerClassName?: string;
  triggerStyle?: CSSProperties;
  leadingIcon?: ReactNode;
  /**
   * 'page'  — trigger sits on the gray page background (e.g. "Last 30 days").
   *            Dropdown gets card bg so it lifts off the page.
   * 'card'  — trigger sits inside a card.
   *            Dropdown gets muted bg so it's distinguishable from the card.
   * Defaults to 'page'.
   */
  variant?: 'page' | 'card';
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select...',
  label,
  className,
  triggerClassName,
  triggerStyle,
  leadingIcon,
  variant = 'page',
}: SelectProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const listId = `${baseId}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>('bottom');
  const [height, setHeight] = useState(0);
  const [rect, setRect] = useState<{ left: number; width: number; top: number; bottom: number } | null>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  // close on outside pointer / escape
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

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });

  // Track the trigger's viewport position so the portaled panel can follow it,
  // and flip upward when there isn't room below and there's more above.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const update = () => {
      const r = trigger.getBoundingClientRect();
      setRect({ left: r.left, width: r.width, top: r.top, bottom: r.bottom });
      const h = innerRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - r.bottom;
      const above = r.top;
      setPlacement(below < h + 16 && above > below ? 'top' : 'bottom');
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const isTop = placement === 'top';

  // Gooey: the edge facing the panel snaps flat (panel attached) then rounds
  // back once the panel pulls away — the two pinch apart.
  const kf = open ? [0, 0, 12] : [12, 0, 12];
  const kfT: Transition = reduce
    ? { duration: 0 }
    : open
      ? { duration: 0.6, times: [0, 0.4, 1], ease: EASE_OUT }
      : { duration: 0.42, times: [0, 0.5, 1], ease: EASE_OUT };
  const flatT: Transition = { duration: 0 };

  const nearGap = open ? 8 : 0;
  const nearRadius = open ? 12 : 0;
  const gapT: Transition = open
    ? { type: 'spring', duration: 0.6, bounce: 0.5, delay: 0.12 }
    : { type: 'spring', duration: 0.3, bounce: 0.1 };
  const radiusT: Transition = open
    ? { duration: 0.3, ease: EASE_OUT, delay: 0.14 }
    : { duration: 0.16, ease: EASE_OUT };
  const instant: Transition = { duration: 0 };

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
          {label}
        </label>
      )}
      <div className="relative">
        <motion.button
          ref={triggerRef}
          type="button"
          id={triggerId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          initial={false}
          animate={{
            borderTopLeftRadius: isTop ? kf : 12,
            borderTopRightRadius: isTop ? kf : 12,
            borderBottomLeftRadius: isTop ? 12 : kf,
            borderBottomRightRadius: isTop ? 12 : kf,
          }}
          transition={{
            borderTopLeftRadius: isTop ? kfT : flatT,
            borderTopRightRadius: isTop ? kfT : flatT,
            borderBottomLeftRadius: isTop ? flatT : kfT,
            borderBottomRightRadius: isTop ? flatT : kfT,
          }}
          style={triggerStyle}
          className={cn(
            'relative z-10 flex h-9 w-full items-center justify-between gap-2 border border-border px-3 py-2 text-sm font-normal text-foreground outline-none transition-colors',
            variant === 'page' ? 'bg-card' : 'bg-muted/50',
            'hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            !selectedOption && 'text-muted-foreground',
            triggerClassName,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {leadingIcon && <span className="shrink-0 text-primary/70">{leadingIcon}</span>}
            <span className="min-w-0 truncate">
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          </span>
          <motion.span
            aria-hidden
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : CHEVRON_TRANSITION}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </motion.span>
        </motion.button>

      </div>

      {/* Portaled to <body> so the panel always renders above cards, tables, and
          other stacking contexts — it can't be clipped/hidden by an ancestor. */}
      {createPortal(
        <motion.div
          ref={panelRef}
          id={listId}
          role="listbox"
          aria-labelledby={triggerId}
          aria-hidden={!open}
          initial={false}
          animate={
            reduce
              ? { opacity: open ? 1 : 0, height: open ? height : 0 }
              : {
                  opacity: open ? 1 : 0,
                  height: open ? height : 0,
                  // gap opens on the side facing the trigger
                  marginTop: isTop ? 0 : nearGap,
                  marginBottom: isTop ? nearGap : 0,
                  // near corners go flat->round; far corners stay rounded
                  borderTopLeftRadius: isTop ? 12 : nearRadius,
                  borderTopRightRadius: isTop ? 12 : nearRadius,
                  borderBottomLeftRadius: isTop ? nearRadius : 12,
                  borderBottomRightRadius: isTop ? nearRadius : 12,
                }
          }
          transition={
            reduce
              ? { duration: 0.12 }
              : {
                  opacity: open ? { duration: 0.18 } : { duration: 0.16, delay: 0.12 },
                  height: open
                    ? { type: 'spring', duration: 0.42, bounce: 0.14 }
                    : { duration: 0.26, ease: EASE_OUT, delay: 0.14 },
                  marginTop: isTop ? instant : gapT,
                  marginBottom: isTop ? gapT : instant,
                  borderTopLeftRadius: isTop ? instant : radiusT,
                  borderTopRightRadius: isTop ? instant : radiusT,
                  borderBottomLeftRadius: isTop ? radiusT : instant,
                  borderBottomRightRadius: isTop ? radiusT : instant,
                }
          }
          style={{
            position: 'fixed',
            left: rect?.left ?? 0,
            width: rect?.width ?? 0,
            top: isTop ? undefined : (rect?.bottom ?? 0),
            bottom: isTop ? window.innerHeight - (rect?.top ?? 0) : undefined,
            transformOrigin: isTop ? 'bottom' : 'top',
            overflow: 'hidden',
            pointerEvents: open ? 'auto' : 'none',
          }}
          // flush against the trigger, then separates into its own rounded pill;
          // sits above or below depending on available space
          className="z-50 border border-border bg-popover shadow-lg shadow-black/[0.03] dark:shadow-black/40"
        >
          <motion.ul
            ref={innerRef}
            variants={reduce ? undefined : LIST_VARIANTS}
            initial={false}
            animate={open ? 'show' : 'hidden'}
            className="max-h-[min(28rem,60vh)] overflow-y-auto p-1"
          >
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <motion.li key={option.value} variants={reduce ? undefined : ITEM_VARIANTS}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 whitespace-normal break-words rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                      selected
                        ? 'bg-primary/10 font-medium text-primary dark:bg-primary/[0.12] dark:text-primary'
                        : 'text-foreground/90 hover:bg-muted hover:text-foreground focus-visible:bg-muted',
                    )}
                  >
                    <span className="min-w-0">{option.label}</span>
                    {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                </motion.li>
              );
            })}
          </motion.ul>
        </motion.div>,
        document.body,
      )}
    </div>
  );
}
