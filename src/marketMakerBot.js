var bluebird  = require('bluebird')
var mangler   = require('mangler')
var affirm    = require('affirm.js')
var _         = require('lodash')
var util      = require('util')
var hedgeInfo = require('./hedgeInfo')
var Debug     = require('debug')

module.exports = function* mmBot(symbol, botParams, account, marginPercent) {
  var debug = Debug('coinpit:mmbot:'+symbol)

  affirm(symbol, "Symbol required to create marketMakerBot")
  var SECOND = 1000
  var MINUTE = 60 * SECOND

  var bot = {}

  var baseurl = botParams.baseurl
  var PREMIUM = botParams.premium
  var DEPTH   = botParams.depth
  var SPREAD  = botParams.spread
  var STEP    = botParams.step
  var STRAT   = botParams.strat
  var CROSS   = botParams.cross
  var STP     = botParams.stop
  var TGT     = botParams.target
  var QTY     = botParams.quantity
  var MAX_QTY = botParams.maxQty
  var SYMBOL  = bot.symbol = symbol
  var counters    = { trade: 0, band: 0 }
  account.logging = true
  var currentBand
  var listener    = bot.listener = {}
  // strategy names and function calls
  bot.marginPercent    = marginPercent
  bot.getMarginPercent = function () {
    return bot.marginPercent
  }
  bot.setMarginPercent = function (marginPercent) {
    bot.marginPercent = marginPercent
  }
  bot.isExpired        = function () {
    return !isActive()
  }

  /** collar strategy basically puts buys and sells around ref price at fixed spread and spacing **/
  bot.collar = function (price) {
    affirm(price && typeof price === 'number', 'Numeric price required for collar')

    var buys            = {}, sells = {}
    var availableMargin = calculateAvailableMargin()
    debug('availableMargin', availableMargin)
    if (availableMargin <= 0) return { buys: buys, sells: sells }
    var inst               = instrument(SYMBOL)
    var satoshiPerQuantity = getSatoshiPerQuantity[inst.type]()
    var max                = Math.floor(availableMargin / (satoshiPerQuantity * QTY * 2))
    var depth              = Math.min(DEPTH, max * STEP)
    var spread             = getSpread()
    var buySpread          = spread, sellSpread = spread
    var position           = account.getPositions()[inst.symbol]

    if (position) {
      var adjustedSpread = mangler.fixed(Math.floor(Math.abs(position.quantity) / 100) / 5)
      buySpread          = position.quantity > 0 ? mangler.fixed(buySpread + adjustedSpread) : buySpread
      sellSpread         = position.quantity < 0 ? mangler.fixed(sellSpread + adjustedSpread) : sellSpread
    }
    var maxBuyCount  = bot.getMaxOrderCounts(position, 'buy')
    var maxSellCount = bot.getMaxOrderCounts(position, 'sell')
    var premium      = bot.getPremium(inst.expiry - Date.now())
    var buyCount     = 0
    for (var i = mangler.fixed(price - buySpread); i > mangler.fixed(price - buySpread - depth); i = mangler.fixed(i - STEP)) {
      if (buyCount >= maxBuyCount) break;
      var buy         = newOrder('buy', bot.getPremiumPrice(i, premium, inst.ticksize), QTY)
      buys[buy.price] = buy
      buyCount += QTY
    }
    var sellCount = 0
    for (var j = mangler.fixed(price + sellSpread); j < mangler.fixed(price + sellSpread + depth); j = mangler.fixed(j + STEP)) {
      if (sellCount >= maxSellCount) break;
      var sell          = newOrder('sell', bot.getPremiumPrice(j, premium, inst.ticksize), QTY)
      sells[sell.price] = sell
      sellCount += QTY
    }
    return { buys: buys, sells: sells }
  }

  bot.getPremiumPrice = function (price, premium, ticksize) {
    var multiplier = Math.pow(10, ticksize)
    return mangler.fixed(Math.round(multiplier * price * (1 + premium)) / multiplier)
  }

  bot.getPremium = function (timeToExpiry) {
    return (timeToExpiry * PREMIUM) / (86400000 * 10000)
  }

  bot.getMaxOrderCounts = function (position, side) {
    if (!position || !position.quantity) return MAX_QTY
    return MAX_QTY + (side === 'sell' ? 1 : -1) * position.quantity
  }

  bot.removeDuplicateOrders = function* () {
    var openOrders = account.getOpenOrders()[SYMBOL]
    if (!openOrders || _.isEmpty(openOrders)) return
    var ordersByPrice     = {}
    var ordersToBeRemoved = _.values(openOrders)
      .filter(order => order.orderType === 'LMT')
      .filter(order => {
        if (ordersByPrice[order.price]) return true
        ordersByPrice[order.price] = order
      })
    var patch             = bot.getCancelPatch(ordersToBeRemoved)
    debug('patch is', patch, ordersToBeRemoved)
    if (patch) yield account.patchOrders(patch)
  }

  var getSatoshiPerQuantity = {
    inverse: function () {
      var inst = instrument(SYMBOL)
      affirm(currentBand && currentBand.price, 'Band price unavailable')
      affirm(inst && inst.stopcushion, 'Instrument cushion unavailable')
      affirm(inst && inst.contractusdvalue, 'Instrument contractusdvalue unavailable')
      var entry = currentBand.price - DEPTH
      var exit  = entry - (STP + inst.stopcushion)
      return Math.ceil(inst.contractusdvalue * 1e8 * (1 / exit - 1 / entry))
    },
    quanto : function () {
      var inst = instrument(SYMBOL)
      return (STP + inst.stopcushion) * inst.ticksperpoint * inst.tickvalue
    }
  }

  /** random strategy assumes best results on random order spacing **/
  bot.random = function (price) {
    var buys = {}, sells = {}
    var bid  = mangler.fixed(price - SPREAD), ask = mangler.fixed(price + SPREAD)
    for (var i = 0; i < DEPTH;) {
      var buyOrder           = newRandomOrder('buy', price, Math.floor(i / 10))
      buys[buyOrder.price]   = buyOrder
      var sellOrder          = newRandomOrder('sell', price, Math.floor(i / 10))
      sells[sellOrder.price] = sellOrder
      i += buyOrder.quantity + sellOrder.quantity
    }
    return { buys: buys, sells: sells }
  }

  function createNewBook(price) {
    var strategy = bot.strategies[STRAT]
    affirm(strategy && typeof strategy === 'function', 'Unknown strategy')
    return strategy(price)
  }

  function getCancels(currentBook, newBook) {
    var d1 = subtract(currentBook.buys, newBook.buys)
    var d2 = subtract(currentBook.sells, newBook.sells)
    return { buys: d1, sells: d2 }
  }

  function getCreates(currentBook, newBook) {
    var d1 = subtract(newBook.buys, currentBook.buys)
    var d2 = subtract(newBook.sells, currentBook.sells)
    return { buys: d1, sells: d2 }
  }

  function subtract(map1, map2) {
    var difference = {}
    Object.keys(map1).forEach(key => {
      if (!map2[key]) difference[key] = map1[key]
    })
    return difference
  }

  function concat(map1, map2) {
    var cat = []
    Object.keys(map1).forEach(key => cat.push(map1[key]))
    Object.keys(map2).forEach(key => cat.push(map2[key]))
    return cat
  }

  function generatePatch(cancels, creates) {
    var buys  = replaceCancelToUpdate(cancels.buys, creates.buys)
    var sells = replaceCancelToUpdate(cancels.sells, creates.sells)
    return { remove: buys.remove.concat(sells.remove), replace: buys.replace.concat(sells.replace), add: buys.add.concat(sells.add) }
  }

  function replaceCancelToUpdate(cancels, creates) {
    cancels     = Object.keys(cancels).map(price => cancels[price])
    creates     = Object.keys(creates).map(price => creates[price])
    var updates = []
    var cancel  = cancels.shift()
    while (cancel) {
      if (creates.length === 0) {
        cancels.push(cancel)
        break
      }
      var create   = creates.shift()
      cancel.price = create.price
      updates.push(cancel)
      cancel = cancels.shift()
    }
    return { remove: cancels, replace: updates, add: creates }
  }

  listener.orderPatch = bluebird.coroutine(function* (response) {
    try {
      for (var i = 0; i < response.result.length; i++) {
        var eachResponse = response.result[i];
        if (eachResponse.error) {
          return jobs.merge = true
        }
        if (eachResponse.op === 'merge' && !currentBand.price) {
          jobs.movePrice = true
        }
      }
    } catch (e) {
      util.log(e);
      util.log(e.stack)
    }
  })

  listener.userMessage = bluebird.coroutine(function* () {
    jobs.merge = true
  })

  listener.trade = bluebird.coroutine(function* () {
    counters.trade++
    jobs.movePrice = true
  })

  listener.priceband = bluebird.coroutine(function* (band) {
    counters.band++
    try {
      if (!band) return debug('bad band ', band)
      currentBand    = band[SYMBOL]
      jobs.movePrice = true
    } catch (e) {
      util.log(e);
      util.log(e.stack)
    }
  })

  var jobs = { movePrice: true, merge: true }

  // var busy      = false
  function getOrders() {
    var allOrders = account.getOpenOrders()
    affirm(allOrders, 'Invalid return for open orders')
    return _.toArray(allOrders[SYMBOL] || {})
  }

  function* movePrice() {
    if (!jobs.movePrice) return
    var price = currentBand.price
    if (isNaN(price)) {
      jobs.movePrice = false
      return debug('invalid price', price)
    }
    jobs.movePrice = false
    try {
      yield* bot.removeDuplicateOrders()
      var orders       = getOrders()
      var currentBook  = getCurrentBook(orders)
      var newBook      = createNewBook(price)
      var patch        = bot.getPatch(currentBook, newBook)
      // updateTargets(patch.replace, currentBook.targets, price, spread)
      var patchPayload = getPatchPayload(patch)
      yield account.patchOrders(patchPayload)
    } catch (e) {
      util.log(e);
      util.log(e.stack)
    }
  }

  function getPatchPayload(patch) {
    var payload = []
    if (isPatchArray(patch.remove)) {
      payload.push({ op: 'remove', value: getUuidList(patch.remove) })
    }
    if (isPatchArray(patch.replace)) {
      payload.push({ op: 'replace', value: getMinimalUpdateList(patch.replace) })
    }
    if (isPatchArray(patch.add)) {
      payload.push({ op: 'add', value: patch.add })
    }
    if (isPatchArray(patch.merge)) {
      payload.push({ op: 'merge', value: getUuidList(patch.merge) })
    }
    return payload
  }

  function getMinimalUpdateList(orders) {
    return orders.map(order => {
      return {
        uuid : order.uuid,
        price: order.price
      }
    })
  }

  function isPatchArray(op) {
    return op && Array.isArray(op) && op.length > 0
  }

  function getUuidList(items) {
    return items.map(item => item.uuid ? item.uuid : item)
  }

  bot.getPatch = function (currentBook, newBook) {
    var cancels = getCancels(currentBook, newBook)
    var creates = getCreates(currentBook, newBook)
    return generatePatch(cancels, creates)
  }

  function* mergePositions() {
    if (!jobs.merge) return
    jobs.merge = false
    try {
      var orders  = getOrders()
      var targets = getCurrentBook(orders).targets
      if (targets.length > 50) {
        targets    = targets.sort(quantityLowToHigh)
        targets    = targets.slice(0, 15)
        var merges = []
        targets.forEach(target => {
          // merges.push(target.uuid)
          merges.push(target.oco)
        })
        yield account.patchOrders([{ op: "merge", value: merges }])
      }
    } catch (e) {
      util.log(e)
      util.log(e.stack)
    }
  }

  function quantityLowToHigh(o1, o2) {
    return toBeFilled(o1) - toBeFilled(o2)
  }

  function toBeFilled(order) {
    return order.quantity - (order.filled || 0) - (order.cancelled || 0)
  }

  function updateTargets(updates, targets, price, spread) {
    var step    = Math.min(spread, STEP)
    var inst    = instrument(SYMBOL)
    var premium = bot.getPremium(inst.expiry - Date.now())
    var bid     = bot.getPremiumPrice(price - spread + step, premium, inst.ticksize)
    var ask     = bot.getPremiumPrice(price + spread - step, premium, inst.ticksize)
    targets.forEach(order => {
      order.price = order.side === 'buy' ? bid : ask
      updates.push(order)
    })
  }

  function getCurrentBook(orders) {
    var ordersByType = { buys: {}, sells: {}, targets: [], stops: [] }
    orders.forEach(order => {
      if (order.orderType === 'LMT' && order.side === 'buy') ordersByType.buys[order.price] = order
      if (order.orderType === 'LMT' && order.side === 'sell') ordersByType.sells[order.price] = order
      if (order.orderType === 'TGT') ordersByType.targets.push(order)
      if (order.orderType === 'STP') ordersByType.stops.push(order)
    })
    return ordersByType
  }

  function newRandomOrder(side, price, distance) {
    var size       = getRandomInt(2, 12)
    var buyStep    = mangler.fixed(getRandomInt(1, 4) / 10)
    var delta      = mangler.fixed((side === 'buy' ? -1 : 1) * (SPREAD + distance))
    var orderPrice = mangler.fixed(price + delta)
    return newOrder(side, orderPrice, size)
  }

  function newOrder(side, price, quantity) {
    var inst = instrument(SYMBOL)
    return {
      clientid   : account.newUUID(),
      userid     : account.userid,
      side       : side,
      quantity   : quantity || 1,
      price      : mangler.fixed(price),
      orderType  : 'LMT',
      stopPrice  : STP,
      targetPrice: 'NONE',//mangler.fixed(SPREAD * 2 - 0.1, inst.ticksize),
      crossMargin: CROSS,
      instrument : SYMBOL
    }
  }

  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  function isActive() {
    try {
      var currentInstrument = instrument(SYMBOL)
      if (!currentInstrument) {
        util.log('isActive: Current instrument for', SYMBOL, 'is', currentInstrument)
        return false
      }
      var cleanupDuration = currentInstrument.expiryClass === 'fiveMinutes' ? 1 * MINUTE : 5 * MINUTE
      return Date.now() <= currentInstrument.expiry - cleanupDuration
    } catch (e) {
      util.log("ERROR isActive", e.stack)
      throw e
    }
  }

  bot.getCancelPatch = function (orders) {
    affirm(Array.isArray(orders), 'Expecting array of orders to cancel' + JSON.stringify(orders))
    var limitOrders = orders.filter(order => order.orderType === 'LMT')
    var deletePatch = limitOrders.map(order => order.uuid)
    return deletePatch.length ? [{ op: 'remove', value: deletePatch }] : undefined
  }

  bot.shutdownBot = function* () {
    var orders = getOrders()
    var patch  = bot.getCancelPatch(orders)
    if (patch) yield account.patchOrders(patch)
    util.log('Shutting down bot for', SYMBOL)
    return true
  }

  var last         = 0
  var moveAndMerge = bluebird.coroutine(function* () {
    var active = true;
    try {
      active = isActive();
      if (!active) return
      yield* movePrice()
      yield* mergePositions()
    } catch (e) {
      util.log("ERROR moveAndMerge", e.stack)
    } finally {
      if (active) setTimeout(moveAndMerge, 100)
      else util.log('BOT', SYMBOL, 'not active', '"' + active + '"')
      if (Date.now() - last > 60000) {
        util.log("STILL RUNNING", SYMBOL, JSON.stringify(counters))
        counters = { trade: 0, band: 0 }
        last     = Date.now()
      }
    }
  })

  function calculateAvailableMargin() {
    var openOrders = account.getOpenOrders()
    affirm(openOrders, 'open orders missing')
    Object.keys(openOrders).forEach(symbol => Object.keys(openOrders[symbol]).forEach(uuid => {
      if (openOrders[symbol][uuid].orderType !== 'STP') delete openOrders[symbol][uuid]
    }))
    return Math.floor(account.calculateAvailableMarginIfCrossShifted(openOrders) * bot.marginPercent / 100)
  }

  function* init() {
    bot.strategies = { 'collar': bot.collar, 'random': bot.random }
    if (CROSS) {
      STP = instrument(SYMBOL).crossMarginInitialStop
    }
    var spread = getSpread()
    var tick   = mangler.fixed(1 / instrument(SYMBOL).ticksperpoint)
    affirm(spread >= tick, 'SPREAD ' + spread + ' is less than tick ' + tick)
    affirm(STEP >= tick, 'STEP ' + STEP + ' is less than tick ' + tick)
    debug('botParams', JSON.stringify({
                                              'baseurl'      : baseurl,
                                              'SYMBOL'       : SYMBOL,
                                              'MARGINPERCENT': marginPercent,
                                              'DEPTH'        : DEPTH,
                                              'SPREAD'       : spread,
                                              'STEP'         : STEP,
                                              'STP'          : STP,
                                              'TGT'          : TGT,
                                              'STRAT'        : STRAT,
                                              'QTY'          : QTY,
                                              CROSS          : CROSS,
                                              PREMIUM        : PREMIUM
                                            }, null, 2))
    var info  = yield account.loginless.rest.get('/all/info')
    // debug('current price', info)
    var price = info[SYMBOL].indexPrice

    currentBand = { price: price }
    yield moveAndMerge()
  }

  function instrument(symbol) {
    return account.getInstruments()[symbol]
  }

  function getSpread() {
    var spread = hedgeInfo.getBitmexSpread() || SPREAD
    debug('spread', spread)
    return spread
  }

  yield* init()
  return bot
}
