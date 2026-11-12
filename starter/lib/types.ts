export type OrderStatus =
  | 'payment_pending'
  | 'paid'
  | 'in_kitchen'
  | 'ready'
  | 'picked_up'
  | 'delivered'
  | 'cancelled';

export type CancellationReason = 'payment_failed' | 'restaurant_refused' | 'no_courier';

export interface Location {
  lat: number;
  lng: number;
}

export interface OrderItem {
  menuItemId: string;
  quantity: number;
}

/** Contenu de l'événement `order.status_changed` (voir README). */
export interface OrderSnapshot {
  orderId: string;
  customerId: string;
  restaurantId: string;
  items: OrderItem[];
  deliveryLocation: Location;
  amountCents: number;
  status: OrderStatus;
  cancellationReason?: CancellationReason;
  courierId?: string;
  at: string;
}
