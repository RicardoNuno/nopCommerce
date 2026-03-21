import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'http://nopcommerce:80';

export const options = {
    stages: [
        { duration: '30s', target: 50 },  // ramp up to 50 concurrent users
        { duration: '4m',  target: 50 },  // hold at 50 users
        { duration: '30s', target: 0 },   // ramp down
    ],
    gracefulRampDown: '30s',  // let in-flight iterations finish before killing VUs
};

// Extract anti-forgery token from HTML response
function getToken(html) {
    const match = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    return match ? match[1] : '';
}

export default function () {
    // Each VU checks out as a guest — no login required.
    const guestEmail = `guest_vu${__VU}_${__ITER}@loadtest.com`;

    // 1. Load homepage
    let res = http.get(`${BASE_URL}/`, { redirects: 5 });

    // 2. Add a product to cart (product ID 1 = "Build your own computer" in sample data)
    res = http.get(`${BASE_URL}/build-your-own-computer`);
    let token = getToken(res.body);

    res = http.post(`${BASE_URL}/addproducttocart/details/1/1`, {
        'product_attribute_1': '1',    // Processor: 2.2 GHz Intel Pentium
        'product_attribute_2': '3',    // RAM: 2 GB
        'product_attribute_3': '6',    // HDD: 320 GB
        'product_attribute_4': '8',    // OS: Vista Home
        'product_attribute_5': '10',   // Software: Microsoft Office
        'addtocart_1.EnteredQuantity': '1',
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        redirects: 5,
    });

    check(res, {
        'added to cart': (r) => {
            try { return JSON.parse(r.body).success === true; } catch(e) { return false; }
        },
    });

    // 3. Set gift wrapping (required checkout attribute) on the cart
    res = http.get(`${BASE_URL}/cart`);
    token = getToken(res.body);

    http.post(`${BASE_URL}/shoppingcart/checkoutattributechange/${true}`, {
        'checkout_attribute_1': '1',   // Gift wrapping: No
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    // 4. Load one-page checkout
    res = http.get(`${BASE_URL}/onepagecheckout`, { redirects: 5 });
    token = getToken(res.body);

    // 5. OPC: Save billing address
    res = http.post(`${BASE_URL}/checkout/OpcSaveBilling/`, {
        'billing_address_id': '0',
        'BillingNewAddress.FirstName': 'Load',
        'BillingNewAddress.LastName': 'Test',
        'BillingNewAddress.Email': guestEmail,
        'BillingNewAddress.CountryId': '1',
        'BillingNewAddress.StateProvinceId': '40',
        'BillingNewAddress.City': 'New York',
        'BillingNewAddress.Address1': '21 West 52nd Street',
        'BillingNewAddress.ZipPostalCode': '10021',
        'BillingNewAddress.PhoneNumber': '12345678',
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    check(res, {
        'billing saved': (r) => {
            try {
                let body = JSON.parse(r.body);
                return body.goto_section === 'shipping' || body.goto_section === 'shipping_method';
            } catch(e) { return false; }
        },
    });

    // 6. OPC: Save shipping address
    res = http.post(`${BASE_URL}/checkout/OpcSaveShipping/`, {
        'shipping_address_id': '0',
        'ShippingNewAddress.FirstName': 'Load',
        'ShippingNewAddress.LastName': 'Test',
        'ShippingNewAddress.Email': guestEmail,
        'ShippingNewAddress.CountryId': '1',
        'ShippingNewAddress.StateProvinceId': '40',
        'ShippingNewAddress.City': 'New York',
        'ShippingNewAddress.Address1': '21 West 52nd Street',
        'ShippingNewAddress.ZipPostalCode': '10021',
        'ShippingNewAddress.PhoneNumber': '12345678',
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    check(res, {
        'shipping address saved': (r) => {
            try { return JSON.parse(r.body).goto_section === 'shipping_method'; } catch(e) { return false; }
        },
    });

    // 7. OPC: Save shipping method (Ground shipping)
    res = http.post(`${BASE_URL}/checkout/OpcSaveShippingMethod/`, {
        'shippingoption': 'Ground___Shipping.FixedByWeightByTotal',
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    check(res, {
        'shipping method saved': (r) => {
            try { return JSON.parse(r.body).goto_section === 'payment_method'; } catch(e) { return false; }
        },
    });

    // 8. OPC: Save payment method (Check/Money Order)
    res = http.post(`${BASE_URL}/checkout/OpcSavePaymentMethod/`, {
        'paymentmethod': 'Payments.CheckMoneyOrder',
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    check(res, {
        'payment method saved': (r) => {
            try {
                let body = JSON.parse(r.body);
                return body.goto_section === 'payment_info' || body.goto_section === 'confirm_order';
            } catch(e) { return false; }
        },
    });

    // 9. OPC: Save payment info (no extra info needed for Check/Money Order)
    res = http.post(`${BASE_URL}/checkout/OpcSavePaymentInfo/`, {
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    check(res, {
        'payment info saved': (r) => {
            try { return JSON.parse(r.body).goto_section === 'confirm_order'; } catch(e) { return false; }
        },
    });

    // 10. OPC: Confirm order - THIS is where our instrumentation fires
    res = http.post(`${BASE_URL}/checkout/OpcConfirmOrder/`, {
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    check(res, {
        'order placed': (r) => {
            try {
                let body = JSON.parse(r.body);
                return body.success === 1 || (body.redirect && body.redirect.includes('checkout'));
            } catch(e) { return false; }
        },
    });

    // Think time between iterations to maintain realistic concurrency
    sleep(2);
}
