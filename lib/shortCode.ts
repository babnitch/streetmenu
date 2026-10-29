// The 4-character code a customer reads out when a QR can't be scanned
// (client-safe). Orders: the last 4 of the id, as the bot's "ok XXXX".
// Event bookings: their reservation_code (else the same rule).

export function orderCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-4).toUpperCase()
}

export function reservationCode(r: { id: string; reservation_code?: string | null }): string {
  return (r.reservation_code || orderCode(r.id)).toUpperCase()
}
