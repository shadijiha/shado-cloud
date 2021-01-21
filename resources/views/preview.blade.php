@extends('layouts.index')

@section('content')
    <div class="container">
        <div class="row">
            <div class="card">
                @foreach(file($file->getPathname()) as $line)
                    {{$line}}
                    <br/>
                @endforeach
            </div>
        </div>
    </div>
@endsection
