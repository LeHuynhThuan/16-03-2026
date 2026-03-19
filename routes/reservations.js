var express = require('express');
var router = express.Router();
let { checkLogin } = require('../utils/authHandler.js')
let mongoose = require('mongoose');
let reservationModel = require('../schemas/reservations')
let cartModel = require('../schemas/cart')
let productModel = require('../schemas/products')
let inventoryModel = require('../schemas/inventories')

router.get('/', checkLogin, async function (req, res, next) {
    try {
        let userId = req.userId;
        let reservations = await reservationModel.find({
            user: userId
        }).populate('items.product');
        res.send(reservations);
    } catch (error) {
        res.status(500).send({ message: error.message });
    }
});

router.get('/:id', checkLogin, async function (req, res, next) {
    try {
        let userId = req.userId;
        let id = req.params.id;
        let reservation = await reservationModel.findOne({
            _id: id,
            user: userId
        }).populate('items.product');
        
        if (!reservation) {
            return res.status(404).send({ message: "Reservation not found" });
        }
        res.send(reservation);
    } catch (error) {
        res.status(500).send({ message: error.message });
    }
});

router.post('/reserveACart', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    let transaction = session.startTransaction();
    try {
        let userId = req.userId;
        
        let cart = await cartModel.findOne({ user: userId }).session(session);
        if (!cart || cart.items.length === 0) {
            await transaction.abort();
            session.endSession();
            return res.status(400).send({ message: "Cart is empty" });
        }

        let totalAmount = 0;
        let reservationItems = [];

        for (let item of cart.items) {
            let product = await productModel.findById(item.product).session(session);
            if (!product) {
                await transaction.abort();
                session.endSession();
                return res.status(404).send({ message: `Product not found: ${item.product}` });
            }

            let inventory = await inventoryModel.findOne({ product: item.product }).session(session);
            if (!inventory || inventory.stock < item.quantity) {
                await transaction.abort();
                session.endSession();
                return res.status(400).send({ message: `Insufficient stock for product: ${product.title}` });
            }

            let subtotal = product.price * item.quantity;
            totalAmount += subtotal;

            reservationItems.push({
                product: item.product,
                quantity: item.quantity,
                price: product.price,
                subtotal: subtotal
            });

            inventory.stock -= item.quantity;
            inventory.reserved += item.quantity;
            await inventory.save({ session });
        }

        let existingReservation = await reservationModel.findOne({ user: userId, status: 'actived' }).session(session);
        if (existingReservation) {
            existingReservation.items = reservationItems;
            existingReservation.totalAmount = totalAmount;
            existingReservation.ExpiredAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await existingReservation.save({ session });
            await transaction.commit();
            session.endSession();
            return res.send(existingReservation);
        }

        let newReservation = new reservationModel({
            user: userId,
            items: reservationItems,
            totalAmount: totalAmount,
            status: 'actived',
            ExpiredAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        });
        await newReservation.save({ session });

        await cartModel.findOneAndUpdate(
            { user: userId },
            { items: [] },
            { session }
        );

        await transaction.commit();
        session.endSession();
        res.send(newReservation);
    } catch (error) {
        await transaction.abort();
        session.endSession();
        res.status(500).send({ message: error.message });
    }
});

router.post('/reserveItems', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    let transaction = session.startTransaction();
    try {
        let userId = req.userId;
        let { items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            await transaction.abort();
            session.endSession();
            return res.status(400).send({ message: "Items array is required" });
        }

        let totalAmount = 0;
        let reservationItems = [];

        for (let item of items) {
            let { product, quantity } = item;
            if (!product || !quantity || quantity < 1) {
                await transaction.abort();
                session.endSession();
                return res.status(400).send({ message: "Invalid product or quantity" });
            }

            let productData = await productModel.findById(product).session(session);
            if (!productData) {
                await transaction.abort();
                session.endSession();
                return res.status(404).send({ message: `Product not found: ${product}` });
            }

            let inventory = await inventoryModel.findOne({ product: product }).session(session);
            if (!inventory || inventory.stock < quantity) {
                await transaction.abort();
                session.endSession();
                return res.status(400).send({ message: `Insufficient stock for product: ${productData.title}` });
            }

            let subtotal = productData.price * quantity;
            totalAmount += subtotal;

            reservationItems.push({
                product: product,
                quantity: quantity,
                price: productData.price,
                subtotal: subtotal
            });

            inventory.stock -= quantity;
            inventory.reserved += quantity;
            await inventory.save({ session });
        }

        let existingReservation = await reservationModel.findOne({ user: userId, status: 'actived' }).session(session);
        if (existingReservation) {
            existingReservation.items = reservationItems;
            existingReservation.totalAmount = totalAmount;
            existingReservation.ExpiredAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await existingReservation.save({ session });
            await transaction.commit();
            session.endSession();
            return res.send(existingReservation);
        }

        let newReservation = new reservationModel({
            user: userId,
            items: reservationItems,
            totalAmount: totalAmount,
            status: 'actived',
            ExpiredAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        });
        await newReservation.save({ session });

        await transaction.commit();
        session.endSession();
        res.send(newReservation);
    } catch (error) {
        await transaction.abort();
        session.endSession();
        res.status(500).send({ message: error.message });
    }
});

router.post('/cancelReserve/:id', checkLogin, async function (req, res, next) {
    let session = await mongoose.startSession();
    let transaction = session.startTransaction();
    try {
        let userId = req.userId;
        let id = req.params.id;

        let reservation = await reservationModel.findOne({
            _id: id,
            user: userId,
            status: 'actived'
        }).session(session);

        if (!reservation) {
            await transaction.abort();
            session.endSession();
            return res.status(404).send({ message: "Reservation not found or already cancelled" });
        }

        for (let item of reservation.items) {
            let inventory = await inventoryModel.findOne({ product: item.product }).session(session);
            if (inventory) {
                inventory.stock += item.quantity;
                inventory.reserved -= item.quantity;
                await inventory.save({ session });
            }
        }

        reservation.status = 'cancelled';
        await reservation.save({ session });

        await transaction.commit();
        session.endSession();
        res.send(reservation);
    } catch (error) {
        await transaction.abort();
        session.endSession();
        res.status(500).send({ message: error.message });
    }
});

module.exports = router;
