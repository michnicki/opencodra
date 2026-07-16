import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Button,
} from 'opencodra';
import { ChevronDown } from 'lucide-react';

// The menu opens on click (open state is internal), so the static card shows
// the trigger; the live card in the DS pane is interactive and opens the menu.
export const Menu = () => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline">
        Actions
        <ChevronDown />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem>Re-run review</DropdownMenuItem>
      <DropdownMenuItem>View pull request</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem>Delete job</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
