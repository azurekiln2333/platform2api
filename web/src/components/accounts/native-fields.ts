export interface AccountField {
  key: string
  label: string
  type?: 'text' | 'number' | 'bool' | 'secret' | 'select' | 'list' | 'email'
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  required?: boolean
  help?: string
}
