## Potential concerns

### Plugins referencing Nop.Web directly

The [official documentation](https://docs.nopcommerce.com/en/developer/plugins/how-to-write-plugin-4.20.html) recommends that plugins reference Nop.Web.Framework, not Nop.Web. However, 17 out of 31 built-in plugins reference Nop.Web directly. This couples those plugins to the entire application (controllers, views, model factories), rather than limiting them to the shared presentation infrastructure that Nop.Web.Framework provides.
