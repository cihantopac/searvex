<?php

use Illuminate\Support\Facades\Route;

Route::get('/', fn () => view('welcome'));
Route::get('/pricing', fn () => view('pricing'));
Route::get('/blog/{post}', fn ($post) => view('post'));
Route::view('/about', 'about');
