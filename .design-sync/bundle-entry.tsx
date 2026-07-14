// Design-sync bundle entry for Codra's UI kit.
//
// codra is an application, not a packaged component library, so there is no
// dist entry to bundle. This barrel re-exports only the design-system
// primitives from src/client/components/ui. Using NAMED re-exports (not
// `export *`) lets esbuild tree-shake away app-coupled exports — notably
// badge.tsx's StatusBadge, which pulls in LiveReviewStepper + @shared/schema.
//
// The converter is pointed here via `--entry .design-sync/bundle-entry.tsx`.
// componentSrcMap in config.json controls which of these get preview cards;
// the compound sub-parts (Card*, DropdownMenu*) are exported here so preview
// compositions can reach them via window.CodraUI.*.

export { Alert } from '@client/components/ui/alert';
export { Badge } from '@client/components/ui/badge';
export { Button } from '@client/components/ui/button';
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from '@client/components/ui/card';
export { ConfirmDialog } from '@client/components/ui/confirm-dialog';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@client/components/ui/dropdown-menu';
export { Input } from '@client/components/ui/input';
export { Select } from '@client/components/ui/select';
export { Switch } from '@client/components/ui/switch';
