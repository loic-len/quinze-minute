CREATE TABLE restaurants (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  kitchen_capacity integer NOT NULL
);

CREATE TABLE menu_items (
  restaurant_id text NOT NULL REFERENCES restaurants (id),
  id            text NOT NULL,
  name          text NOT NULL,
  price_cents   integer NOT NULL,
  PRIMARY KEY (restaurant_id, id)
);

CREATE TABLE couriers (
  id        text PRIMARY KEY,
  lat       double precision NOT NULL,
  lng       double precision NOT NULL,
  available boolean NOT NULL DEFAULT true
);

CREATE TABLE orders (
  id                  uuid PRIMARY KEY,
  idempotency_key     text NOT NULL,
  customer_id         text NOT NULL,
  restaurant_id       text NOT NULL,
  items               jsonb NOT NULL,
  delivery_lat        double precision NOT NULL,
  delivery_lng        double precision NOT NULL,
  amount_cents        integer NOT NULL,
  status              text NOT NULL,
  cancellation_reason text,
  courier_id          text,
  eta_seconds         integer,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_status_history (
  id       bigserial PRIMARY KEY,
  order_id uuid NOT NULL,
  status   text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_id ON order_status_history (order_id);

CREATE TABLE payments (
  id         text PRIMARY KEY,
  order_id   uuid NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_id ON payments (order_id);

CREATE TABLE kitchen_orders (
  order_id      uuid PRIMARY KEY,
  restaurant_id text NOT NULL,
  state         text NOT NULL
);
