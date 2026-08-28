import type { ButtonHTMLAttributes } from 'react'
import { buttonClass, cn, iconButtonClass, type ButtonSize, type ButtonVariant } from './styles.ts'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({ variant, size, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cn(buttonClass(variant, size), className)} {...rest} />
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Exclude<ButtonVariant, 'primary'>
  /** Required: the button renders an icon, so the accessible name has to come from somewhere. */
  'aria-label': string
}

export function IconButton({ variant, className, type = 'button', ...rest }: IconButtonProps) {
  return <button type={type} className={cn(iconButtonClass(variant), className)} {...rest} />
}
