import { EventEmitter } from 'events'

export const priceEmitter = new EventEmitter()

export const PRICE_UPDATE = 'price:update'

export interface PriceUpdateEvent {
  assetA: string
  assetB: string
  previousPrice: number
  currentPrice: number
  timestamp: Date
}
