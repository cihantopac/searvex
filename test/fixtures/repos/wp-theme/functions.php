<?php
function acme_enqueue() {
	wp_enqueue_style( 'acme', get_stylesheet_uri() );
}
add_action( 'wp_enqueue_scripts', 'acme_enqueue' );
