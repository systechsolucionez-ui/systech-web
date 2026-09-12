# Landing Systech

## Catálogo dinámico
Desde ahora, el catálogo de productos de esta landing **no se edita más en este HTML**. Vive en el [Sistema Administrativo de Catálogo](../admin-systech/), y esta página lo consume en vivo por API.

Para dar de alta un producto nuevo, cambiar un precio, o marcar algo como "Disponible", usá el panel de administración de ese otro sistema — se refleja acá automáticamente, sin tocar código.

## Si el backend del catálogo no está desplegado todavía
La landing tiene un catálogo de respaldo (`PRODUCTS_RESPALDO`, dentro del `<script>` al final del HTML) que se usa automáticamente si no puede conectar a la API. Sirve para que la página nunca se vea vacía, pero conviene no depender de él por mucho tiempo — la fuente de verdad real es el panel de administración.

## Conectar al backend real
Buscá esta línea en `index.html` y actualizala con la URL pública del backend una vez desplegado:
```js
const CATALOG_API_URL = "http://localhost:4300/api/publico/productos";
```

## Manual de productos
Cada producto "Disponible" enlaza a `manual.html` (incluido en esta misma carpeta), a la sección específica de ese producto.
