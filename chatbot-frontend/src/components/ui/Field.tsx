import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cn, INPUT_CLASS } from './styles.ts'

/** A labelled control. The label is a real `<label for>`, so tapping it focuses the input. */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLASS, className)} {...rest} />
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(INPUT_CLASS, 'cursor-pointer', className)} {...rest} />
}
