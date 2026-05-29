export type OrderItem = {
  id: string
  title: string
  price: number
  category: string
  finalSale?: boolean
}

export type Order = {
  id: string
  email: string
  customerName: string
  status: 'processing' | 'shipped' | 'delivered' | 'delayed'
  placedOn: string
  estimatedDelivery?: string
  deliveredOn?: string
  trackingNumber?: string
  carrier?: string
  items: OrderItem[]
}

export const orders: Order[] = [
  {
    id: 'B1001',
    email: 'mira@example.com',
    customerName: 'Mira',
    status: 'shipped',
    placedOn: '2026-05-23',
    estimatedDelivery: '2026-05-31',
    trackingNumber: '1Z-BOOKLY-1001',
    carrier: 'UPS',
    items: [
      {
        id: 'I-11',
        title: 'The Pragmatic Programmer',
        price: 42,
        category: 'technology',
      },
    ],
  },
  {
    id: 'B1002',
    email: 'devon@example.com',
    customerName: 'Devon',
    status: 'delivered',
    placedOn: '2026-05-05',
    deliveredOn: '2026-05-10',
    items: [
      {
        id: 'I-21',
        title: 'Designing Data-Intensive Applications',
        price: 55,
        category: 'technology',
      },
      {
        id: 'I-22',
        title: 'Signed Collector Edition: Dune',
        price: 85,
        category: 'collector',
        finalSale: true,
      },
    ],
  },
  {
    id: 'B1003',
    email: 'jules@example.com',
    customerName: 'Jules',
    status: 'delivered',
    placedOn: '2026-03-14',
    deliveredOn: '2026-03-20',
    items: [
      {
        id: 'I-31',
        title: 'Tomorrow, and Tomorrow, and Tomorrow',
        price: 29,
        category: 'fiction',
      },
    ],
  },
  {
    id: 'B1004',
    email: 'sam@example.com',
    customerName: 'Sam',
    status: 'delayed',
    placedOn: '2026-05-20',
    estimatedDelivery: '2026-06-03',
    trackingNumber: '9400-BOOKLY-1004',
    carrier: 'USPS',
    items: [
      {
        id: 'I-41',
        title: 'Project Hail Mary',
        price: 18,
        category: 'fiction',
      },
    ],
  },
]
