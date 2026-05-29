export type PolicyTopic = 'shipping' | 'returns' | 'refunds' | 'password_reset'

export type Policy = {
  topic: PolicyTopic
  title: string
  summary: string
}

export const policies: Policy[] = [
  {
    topic: 'shipping',
    title: 'Shipping policy',
    summary:
      'Standard shipping takes 3-7 business days after fulfillment. Customers can use the carrier tracking number once an order ships.',
  },
  {
    topic: 'returns',
    title: 'Return policy',
    summary:
      'Most books can be returned within 30 days of delivery if they are in resellable condition. Signed collector editions and final-sale items are not eligible.',
  },
  {
    topic: 'refunds',
    title: 'Refund timing',
    summary:
      'Approved refunds are issued to the original payment method after the returned item is scanned by the carrier. Processing usually takes 5-7 business days.',
  },
  {
    topic: 'password_reset',
    title: 'Password reset',
    summary:
      'Customers can reset their password from the sign-in page. Bookly sends a one-time reset link to the account email address.',
  },
]
