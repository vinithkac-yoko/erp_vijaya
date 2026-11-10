'use client';

import * as React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/cn';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuLabel = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof Menu.Label>>(
  function DropdownMenuLabel({ className, ...p }, ref) {
    return <Menu.Label ref={ref} className={cn('px-3 py-2 text-sm text-ink-soft', className)} {...p} />;
  });
export const DropdownMenuSeparator = () => <Menu.Separator className="my-1 h-px bg-line" />;

export const DropdownMenuContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof Menu.Content>>(
  function DropdownMenuContent({ className, sideOffset = 6, ...p }, ref) {
    return (
      <Menu.Portal>
        <Menu.Content ref={ref} sideOffset={sideOffset} collisionPadding={8}
          className={cn('z-50 min-w-52 max-w-[calc(100vw-16px)] rounded-md border border-line bg-surface p-1 text-ink shadow-md', className)} {...p} />
      </Menu.Portal>
    );
  });

export const DropdownMenuItem = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof Menu.Item>>(
  function DropdownMenuItem({ className, ...p }, ref) {
    return (
      <Menu.Item ref={ref}
        className={cn('flex min-h-11 md:min-h-9 cursor-pointer select-none items-center gap-2 rounded-md px-3 text-base outline-none ' +
          'data-[highlighted]:bg-copper-wash data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-faint', className)} {...p} />
    );
  });
