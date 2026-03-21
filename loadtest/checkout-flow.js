import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'http://nopcommerce:80';

export const options = {
    stages: [
        { duration: '30s', target: 50 },  // ramp up to 50 concurrent users
        { duration: '4m',  target: 50 },  // hold at 50 users — one VU per account
        { duration: '30s', target: 0 },   // ramp down
    ],
    gracefulRampDown: '30s',  // let in-flight iterations finish before killing VUs
};

// 5 sample-data accounts + 45 load-test accounts (all password: 123456).
// Each VU gets its own account (1:1) to avoid shopping cart race conditions.
const USERS = [
    'steve_gates@nopCommerce.com',
    'brenda_lindgren@nopCommerce.com',
    'victoria_victoria@nopCommerce.com',
    'arthur_holmes@nopCommerce.com',
    'james_pan@nopCommerce.com',
    ...Array.from({ length: 45 }, (_, i) => `loadtest${i + 1}@nopCommerce.com`),
];

// Extract anti-forgery token from HTML response
function getToken(html) {
    const match = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    return match ? match[1] : '';
}

export default function () {
    // Each VU uses a different user to avoid cart collisions
    const email = USERS[(__VU - 1) % USERS.length];

    // 1. Load homepage
    let res = http.get(`${BASE_URL}/`, { redirects: 5 });

    // 2. Login
    res = http.get(`${BASE_URL}/login`);
    let token = getToken(res.body);

    res = http.post(`${BASE_URL}/login`, {
        Email: email,
        Password: '123456',
        '__RequestVerificationToken': token,
    }, { redirects: 5 });

    check(res, {
        'login successful': (r) => r.status === 200 && !r.body.includes('Login was unsuccessful'),
    });

    // 3. Add a product to cart (product ID 1 = "Build your own computer" in sample data)
    res = http.get(`${BASE_URL}/build-your-own-computer`);
    token = getToken(res.body);

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

    // 4. Set gift wrapping (required checkout attribute) on the cart
    res = http.get(`${BASE_URL}/cart`);
    token = getToken(res.body);

    http.post(`${BASE_URL}/shoppingcart/checkoutattributechange/${true}`, {
        'checkout_attribute_1': '1',   // Gift wrapping: No
        '__RequestVerificationToken': token,
    }, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    // 5. Load one-page checkout
    res = http.get(`${BASE_URL}/onepagecheckout`, { redirects: 5 });
    token = getToken(res.body);

    // 6. OPC: Save billing address (submit new address to avoid ID conflicts)
    res = http.post(`${BASE_URL}/checkout/OpcSaveBilling/`, {
        'billing_address_id': '0',
        'BillingNewAddress.FirstName': 'Load',
        'BillingNewAddress.LastName': 'Test',
        'BillingNewAddress.Email': email,
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

    // 7. OPC: Save shipping address (use same as billing = submit new)
    res = http.post(`${BASE_URL}/checkout/OpcSaveShipping/`, {
        'shipping_address_id': '0',
        'ShippingNewAddress.FirstName': 'Load',
        'ShippingNewAddress.LastName': 'Test',
        'ShippingNewAddress.Email': email,
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

    // 8. OPC: Save shipping method (Ground shipping)
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

    // 9. OPC: Save payment method (Check/Money Order)
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

    // 10. OPC: Save payment info (no extra info needed for Check/Money Order)
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

    // 11. OPC: Confirm order - THIS is where our instrumentation fires
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

    // Shorter think time to compensate for fewer VUs while keeping
    // enough concurrency for the in-flight gauge to show real overlap.
    sleep(2);
}
