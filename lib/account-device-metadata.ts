export function validDeviceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  )
}
