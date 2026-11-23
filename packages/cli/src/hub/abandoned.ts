let abandoned = false;
export function syncAbandoned(): boolean {
  return abandoned;
}

export function abandonSync(): void {
  abandoned = true;
}
