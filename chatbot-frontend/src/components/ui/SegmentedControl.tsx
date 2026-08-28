import { cn } from './styles.ts'

/**
 * A two-or-three-way switch between views of the same data.
 *
 * Radio semantics rather than a row of buttons: the options are mutually exclusive, and a screen
 * reader should say "1 of 2 selected" rather than announcing two unrelated buttons.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  /** Names the group as a whole — "View mode", not the individual options. */
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            value === option.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
