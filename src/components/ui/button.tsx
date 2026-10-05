import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

// ≥ 44 px on a phone, ≥ 36 px on a desktop (INTERFACE §3, §14).
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap select-none transition-colors duration-150 ' +
    'disabled:cursor-not-allowed disabled:opacity-60 min-h-11 md:min-h-9 px-4',
  {
    variants: {
      variant: {
        primary: 'bg-copper text-on-copper border border-copper hover:bg-copper-deep hover:border-copper-deep',
        secondary: 'bg-surface text-ink border border-line hover:bg-copper-wash',
        ghost: 'bg-transparent text-copper-deep border border-transparent hover:bg-copper-wash',
      },
      size: { md: 'text-base', sm: 'text-sm px-3' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, type = 'button', ...props }, ref) {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} type={asChild ? undefined : type} className={cn(button({ variant, size }), className)} {...props} />;
});
